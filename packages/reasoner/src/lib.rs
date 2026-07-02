#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi::{Env, Task};
use napi_derive::napi;
use oxrdf::Triple as OxTriple;
use reasonable::common::rio_to_oxrdf;
use reasonable::reasoner::Reasoner;
use rio_api::parser::TriplesParser;
use rio_turtle::{TurtleError, TurtleParser};

#[napi(object)]
pub struct Triple {
  pub subject: String,
  pub predicate: String,
  pub object: String,
}

/// Parse a Turtle/N-Triples string straight into oxrdf triples in memory.
///
/// The previous implementation wrote the TTL to a hard-coded
/// `/tmp/{tbox,abox}_<pid>.ttl` file and called `Reasoner::load_file`. That was
/// broken in three ways:
///   1. `/tmp` does not exist on Windows even though a win32 `.node` binary
///      ships — reasoning simply failed there.
///   2. The filename keyed only on the PID, so two concurrent `inferTriples`
///      calls in the same process (e.g. from worker threads) raced on the same
///      path, and the predictable name on a shared `/tmp` was a symlink-attack
///      surface.
///   3. On a load error the `remove_file` cleanup was skipped, leaking the file.
///
/// `Reasoner::load_file` merely runs the RDF text through rio's `TurtleParser`
/// and hands the resulting triples to `load_triples`, so we replicate exactly
/// that pipeline here — no filesystem involved. N-Triples is a syntactic subset
/// of Turtle, so a single Turtle parser covers both the Turtle TBox/ABox and the
/// N-Triples new-fact fragment the caller appends.
fn parse_ttl(ttl: &str) -> Result<Vec<OxTriple>> {
  let mut triples: Vec<OxTriple> = Vec::new();
  TurtleParser::new(ttl.as_bytes(), None)
    .parse_all(&mut |t| {
      triples.push(rio_to_oxrdf(t));
      Ok(()) as std::result::Result<(), TurtleError>
    })
    .map_err(|e| Error::from_reason(e.to_string()))?;
  Ok(triples)
}

/// Runs OWL 2 RL materialization over `tbox_ttl` + `abox_ttl`. Kept free of any
/// napi/JS types so it can execute on a libuv worker thread (see `InferTask`).
fn run_inference(tbox_ttl: &str, abox_ttl: &str) -> Result<Vec<Triple>> {
  let mut r = Reasoner::new();

  if !tbox_ttl.is_empty() {
    r.load_triples(parse_ttl(tbox_ttl)?);
  }
  if !abox_ttl.is_empty() {
    r.load_triples(parse_ttl(abox_ttl)?);
  }

  r.reason();

  let inferred = r.get_triples();
  let mut result = Vec::with_capacity(inferred.len());
  for t in inferred {
    result.push(Triple {
      subject: t.subject.to_string(),
      predicate: t.predicate.to_string(),
      object: t.object.to_string(),
    });
  }
  Ok(result)
}

/// napi async task: the heavy `run_inference` call happens in `compute`, which
/// napi-rs schedules on the libuv thread pool. This keeps the Node event loop
/// free during a reasoning run (the old synchronous `#[napi]` fn blocked it for
/// the whole materialization).
pub struct InferTask {
  tbox_ttl: String,
  abox_ttl: String,
}

#[napi]
impl Task for InferTask {
  type Output = Vec<Triple>;
  type JsValue = Vec<Triple>;

  fn compute(&mut self) -> Result<Self::Output> {
    run_inference(&self.tbox_ttl, &self.abox_ttl)
  }

  fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
    Ok(output)
  }
}

/// Materializes the OWL 2 RL closure of `tbox_ttl` + `abox_ttl`.
///
/// Returns a `Promise` (via napi `AsyncTask`) so callers `await` it and the
/// event loop stays responsive; the actual reasoning runs off-thread.
#[napi]
pub fn infer_triples(tbox_ttl: String, abox_ttl: String) -> AsyncTask<InferTask> {
  AsyncTask::new(InferTask {
    tbox_ttl,
    abox_ttl,
  })
}
