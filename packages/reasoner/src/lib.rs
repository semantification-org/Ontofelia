#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use reasonable::reasoner::Reasoner;
use std::fs;

#[napi(object)]
pub struct Triple {
  pub subject: String,
  pub predicate: String,
  pub object: String,
}

#[napi]
pub fn infer_triples(tbox_ttl: String, abox_ttl: String) -> Result<Vec<Triple>> {
  let mut r = Reasoner::new();
  
  if !tbox_ttl.is_empty() {
      let tbox_path = format!("/tmp/tbox_{}.ttl", std::process::id());
      fs::write(&tbox_path, tbox_ttl)?;
      r.load_file(&tbox_path).map_err(|e| Error::from_reason(e.to_string()))?;
      let _ = fs::remove_file(&tbox_path);
  }
  
  if !abox_ttl.is_empty() {
      let abox_path = format!("/tmp/abox_{}.ttl", std::process::id());
      fs::write(&abox_path, abox_ttl)?;
      r.load_file(&abox_path).map_err(|e| Error::from_reason(e.to_string()))?;
      let _ = fs::remove_file(&abox_path);
  }
  
  r.reason();
  
  let inferred = r.get_triples();
  let mut result = Vec::new();
  for t in inferred {
      result.push(Triple {
          subject: t.subject.to_string(),
          predicate: t.predicate.to_string(),
          object: t.object.to_string(),
      });
  }
  
  Ok(result)
}
