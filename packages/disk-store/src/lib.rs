//! Persistent RDF quad store (RocksDB-backed `oxigraph::store::Store`) exposed to
//! Node.js through N-API.
//!
//! Every fallible call returns a JS exception carrying the Rust error message.
//! Panics are caught and converted into exceptions as well, so a bad input can
//! never abort the host process.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use napi::bindgen_prelude::AsyncTask;
use napi::{Env, Error, JsString, Result, Status, Task};
use napi_derive::napi;
use oxigraph::io::{RdfFormat, RdfParser, RdfSerializer};
use oxigraph::model::{GraphName, NamedNode};
use oxigraph::sparql::results::{QueryResultsFormat, QueryResultsSerializer};
use oxigraph::sparql::{CancellationToken, QueryEvaluationError, QueryResults, SparqlEvaluator};
use oxigraph::store::Store;

fn err(message: impl std::fmt::Display) -> Error {
  Error::new(Status::GenericFailure, message.to_string())
}

/// Runs `f`, turning a panic into a regular error.
fn guard<T>(f: impl FnOnce() -> Result<T>) -> Result<T> {
  match catch_unwind(AssertUnwindSafe(f)) {
    Ok(result) => result,
    Err(payload) => {
      let detail = payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic".to_string());
      Err(err(format!("internal error: {detail}")))
    }
  }
}

fn parse_format(format: &str) -> Result<RdfFormat> {
  // Accept a media type, optionally with parameters (e.g. "text/turtle; charset=utf-8").
  let media_type = format.split(';').next().unwrap_or("").trim();
  RdfFormat::from_media_type(media_type).ok_or_else(|| err(format!("unsupported RDF format: {format}")))
}

fn named_graph(iri: &str) -> Result<NamedNode> {
  NamedNode::new(iri).map_err(|e| err(format!("invalid graph IRI <{iri}>: {e}")))
}

/// Why a query did not produce a result.
enum QueryFailure {
  /// The cancellation token fired.
  Cancelled,
  Failed(Error),
}

impl QueryFailure {
  fn into_error(self) -> Error {
    match self {
      // Only reachable when a token was passed in, which `query` never does.
      QueryFailure::Cancelled => err("query cancelled"),
      QueryFailure::Failed(e) => e,
    }
  }
}

fn eval_failure(e: QueryEvaluationError) -> QueryFailure {
  match e {
    QueryEvaluationError::Cancelled => QueryFailure::Cancelled,
    other => QueryFailure::Failed(err(other)),
  }
}

fn failed(e: impl std::fmt::Display) -> QueryFailure {
  QueryFailure::Failed(err(e))
}

/// Evaluates `sparql` against `store` and serialises the result: SELECT/ASK as
/// application/sparql-results+json, CONSTRUCT/DESCRIBE as N-Triples. Iterating
/// and serialising the results happens in here, so a cancellation token covers
/// the whole run. Shared by `query` and `queryAsync`.
fn run_query(
  store: &Store,
  sparql: &str,
  default_graph: Option<&str>,
  token: Option<CancellationToken>,
) -> std::result::Result<String, QueryFailure> {
  let mut evaluator = SparqlEvaluator::new();
  if let Some(token) = token {
    evaluator = evaluator.with_cancellation_token(token);
  }
  let mut prepared = evaluator.parse_query(sparql).map_err(failed)?;
  if let Some(graph) = default_graph {
    prepared
      .dataset_mut()
      .set_default_graph(vec![GraphName::NamedNode(named_graph(graph).map_err(QueryFailure::Failed)?)]);
  }
  match prepared.on_store(store).execute().map_err(eval_failure)? {
    QueryResults::Solutions(solutions) => {
      let variables = solutions.variables().to_vec();
      let mut serializer = QueryResultsSerializer::from_format(QueryResultsFormat::Json)
        .serialize_solutions_to_writer(Vec::new(), variables)
        .map_err(failed)?;
      for solution in solutions {
        let solution = solution.map_err(eval_failure)?;
        serializer.serialize(solution.iter()).map_err(failed)?;
      }
      let bytes = serializer.finish().map_err(failed)?;
      String::from_utf8(bytes).map_err(failed)
    }
    QueryResults::Boolean(value) => {
      let bytes = QueryResultsSerializer::from_format(QueryResultsFormat::Json)
        .serialize_boolean_to_writer(Vec::new(), value)
        .map_err(failed)?;
      String::from_utf8(bytes).map_err(failed)
    }
    QueryResults::Graph(triples) => {
      let mut serializer = RdfSerializer::from_format(RdfFormat::NTriples).for_writer(Vec::new());
      for triple in triples {
        serializer
          .serialize_triple(&triple.map_err(eval_failure)?)
          .map_err(failed)?;
      }
      let bytes = serializer.finish().map_err(failed)?;
      String::from_utf8(bytes).map_err(failed)
    }
  }
}

/// The work behind `queryAsync`, run on the libuv thread pool.
pub struct QueryTask {
  store: std::result::Result<Store, String>,
  sparql: String,
  default_graph: Option<String>,
  timeout_ms: f64,
}

impl Task for QueryTask {
  type Output = String;
  type JsValue = JsString;

  fn compute(&mut self) -> Result<String> {
    guard(|| {
      if !(self.timeout_ms.is_finite() && self.timeout_ms > 0.0) {
        return Err(err("timeoutMs must be a positive number"));
      }
      let store = self.store.clone().map_err(err)?;
      let timeout = Duration::try_from_secs_f64(self.timeout_ms / 1000.0)
        .unwrap_or(Duration::from_secs(u32::MAX as u64));

      let token = CancellationToken::new();
      // Watchdog: waits on a channel instead of sleeping, so dropping the sender
      // wakes it at once when the query finishes first. It cancels only when the
      // wait runs out.
      let (done_tx, done_rx) = mpsc::channel::<()>();
      let watchdog_token = token.clone();
      let watchdog = std::thread::Builder::new()
        .name("disk-store-query-watchdog".to_string())
        .spawn(move || {
          if let Err(mpsc::RecvTimeoutError::Timeout) = done_rx.recv_timeout(timeout) {
            watchdog_token.cancel();
          }
        })
        .map_err(|e| err(format!("could not start the query watchdog: {e}")))?;

      // `guard` inside: a panic in the query must not skip stopping the watchdog.
      let outcome = guard(|| {
        run_query(&store, &self.sparql, self.default_graph.as_deref(), Some(token))
          .map_err(|failure| match failure {
            QueryFailure::Cancelled => err(format!("QUERY_TIMEOUT: query exceeded {} ms", self.timeout_ms)),
            QueryFailure::Failed(e) => e,
          })
      });

      drop(done_tx);
      let _ = watchdog.join();
      outcome
    })
  }

  fn resolve(&mut self, env: Env, output: String) -> Result<JsString> {
    env.create_string_from_std(output)
  }
}

/// A persistent quad store living in a directory on disk.
#[napi]
pub struct DiskStore {
  // `None` once closed. `Store` is a cheap reference-counted handle; the
  // RocksDB lock is released when the last handle is dropped.
  inner: Mutex<Option<Store>>,
}

impl DiskStore {
  fn wrap(store: Store) -> Self {
    DiskStore {
      inner: Mutex::new(Some(store)),
    }
  }

  fn store(&self) -> Result<Store> {
    let guard = self.inner.lock().map_err(|_| err("store lock poisoned"))?;
    guard.clone().ok_or_else(|| err("store is closed"))
  }
}

#[napi]
impl DiskStore {
  /// Opens (and creates, if missing) a read-write store in `path`.
  #[napi(factory)]
  pub fn open(path: String) -> Result<Self> {
    guard(|| Store::open(&path).map(Self::wrap).map_err(err))
  }

  /// Opens an existing store read-only. Writes throw.
  #[napi(factory)]
  pub fn open_read_only(path: String) -> Result<Self> {
    guard(|| Store::open_read_only(&path).map(Self::wrap).map_err(err))
  }

  /// Parses `data` in the given media type and inserts it. Triple formats load
  /// into `toGraph` (default graph when omitted); quad formats keep their own
  /// graph names. The load is atomic.
  #[napi]
  pub fn load(&self, data: String, format: String, to_graph: Option<String>) -> Result<()> {
    guard(|| {
      let store = self.store()?;
      let mut parser = RdfParser::from_format(parse_format(&format)?);
      if let Some(graph) = to_graph {
        parser = parser.with_default_graph(GraphName::NamedNode(named_graph(&graph)?));
      }
      store.load_from_reader(parser, data.as_bytes()).map_err(err)
    })
  }

  /// Serializes all quads in the given dataset media type (e.g. application/n-quads).
  #[napi]
  pub fn dump(&self, format: String) -> Result<String> {
    guard(|| {
      let store = self.store()?;
      let serializer = RdfSerializer::from_format(parse_format(&format)?);
      let bytes = store.dump_to_writer(serializer, Vec::new()).map_err(err)?;
      String::from_utf8(bytes).map_err(err)
    })
  }

  /// Runs a SPARQL query. SELECT/ASK return application/sparql-results+json text,
  /// CONSTRUCT/DESCRIBE return application/n-triples text. When `defaultGraph`
  /// is given, it alone is the query's default graph. Blocks the calling thread
  /// until the query is done; use `queryAsync` when a deadline is needed.
  #[napi]
  pub fn query(&self, sparql: String, default_graph: Option<String>) -> Result<String> {
    guard(|| {
      let store = self.store()?;
      run_query(&store, &sparql, default_graph.as_deref(), None).map_err(QueryFailure::into_error)
    })
  }

  /// Like `query`, but runs on the libuv thread pool (the JS thread stays free)
  /// and is cancelled after `timeoutMs` milliseconds. The deadline covers
  /// evaluation, iterating and serialising the results. On expiry the promise
  /// rejects with an error whose message starts with `QUERY_TIMEOUT`.
  ///
  /// Cancellation is noticed whenever evaluation reads the next quad, so a query
  /// that keeps scanning (property paths, joins that look data up) stops within
  /// milliseconds. A phase that only combines already buffered intermediate
  /// results, such as an unconstrained cross product of independent patterns, is
  /// not interrupted until evaluation touches the data again.
  #[napi(ts_return_type = "Promise<string>")]
  pub fn query_async(
    &self,
    sparql: String,
    default_graph: Option<String>,
    timeout_ms: f64,
  ) -> AsyncTask<QueryTask> {
    // Everything that can fail is reported through the promise, not thrown.
    AsyncTask::new(QueryTask {
      store: self.store().map_err(|e| e.reason.clone()),
      sparql,
      default_graph,
      timeout_ms,
    })
  }

  /// Runs a SPARQL update.
  #[napi]
  pub fn update(&self, sparql: String) -> Result<()> {
    guard(|| {
      let store = self.store()?;
      SparqlEvaluator::new()
        .parse_update(&sparql)
        .map_err(err)?
        .on_store(&store)
        .execute()
        .map_err(err)
    })
  }

  /// Number of quads in the store.
  #[napi]
  pub fn len(&self) -> Result<i64> {
    guard(|| {
      let store = self.store()?;
      store.len().map(|n| n as i64).map_err(err)
    })
  }

  /// Flushes the write-ahead log and memtables to disk.
  #[napi]
  pub fn flush(&self) -> Result<()> {
    guard(|| self.store()?.flush().map_err(err))
  }

  /// Releases the store and its directory lock. Later calls throw "store is closed".
  /// Closing twice is a no-op.
  #[napi]
  pub fn close(&self) -> Result<()> {
    let mut guard = self.inner.lock().map_err(|_| err("store lock poisoned"))?;
    guard.take();
    Ok(())
  }
}
