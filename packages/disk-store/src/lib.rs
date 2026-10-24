//! Persistent RDF quad store (RocksDB-backed `oxigraph::store::Store`) exposed to
//! Node.js through N-API.
//!
//! Every fallible call returns a JS exception carrying the Rust error message.
//! Panics are caught and converted into exceptions as well, so a bad input can
//! never abort the host process.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;

use napi::{Error, Result, Status};
use napi_derive::napi;
use oxigraph::io::{RdfFormat, RdfParser, RdfSerializer};
use oxigraph::model::{GraphName, NamedNode};
use oxigraph::sparql::results::{QueryResultsFormat, QueryResultsSerializer};
use oxigraph::sparql::{QueryResults, SparqlEvaluator};
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
  /// is given, it alone is the query's default graph.
  #[napi]
  pub fn query(&self, sparql: String, default_graph: Option<String>) -> Result<String> {
    guard(|| {
      let store = self.store()?;
      let mut prepared = SparqlEvaluator::new().parse_query(&sparql).map_err(err)?;
      if let Some(graph) = default_graph {
        prepared
          .dataset_mut()
          .set_default_graph(vec![GraphName::NamedNode(named_graph(&graph)?)]);
      }
      match prepared.on_store(&store).execute().map_err(err)? {
        QueryResults::Solutions(solutions) => {
          let variables = solutions.variables().to_vec();
          let mut serializer = QueryResultsSerializer::from_format(QueryResultsFormat::Json)
            .serialize_solutions_to_writer(Vec::new(), variables)
            .map_err(err)?;
          for solution in solutions {
            let solution = solution.map_err(err)?;
            serializer.serialize(solution.iter()).map_err(err)?;
          }
          let bytes = serializer.finish().map_err(err)?;
          String::from_utf8(bytes).map_err(err)
        }
        QueryResults::Boolean(value) => {
          let bytes = QueryResultsSerializer::from_format(QueryResultsFormat::Json)
            .serialize_boolean_to_writer(Vec::new(), value)
            .map_err(err)?;
          String::from_utf8(bytes).map_err(err)
        }
        QueryResults::Graph(triples) => {
          let mut serializer = RdfSerializer::from_format(RdfFormat::NTriples).for_writer(Vec::new());
          for triple in triples {
            serializer
              .serialize_triple(&triple.map_err(err)?)
              .map_err(err)?;
          }
          let bytes = serializer.finish().map_err(err)?;
          String::from_utf8(bytes).map_err(err)
        }
      }
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
