// Development-only oracle linked against an operator-provided pinned checkout.
// No upstream source, Rust dependency or resulting binary ships with PwrAgent.
use std::io::{self, Read};
use nucleus_discovery_interface::{ProblemsResult, RunStatus, TreeResult};
use nucleus_swarm_interface::SwarmRecord;
use serde_json::{Value, json};

fn main() {
  let mut input = String::new();
  io::stdin().read_to_string(&mut input).unwrap();
  let value: Value = serde_json::from_str(&input).unwrap();
  let status: RunStatus = serde_json::from_value(value["discovery"]["status"].clone()).unwrap();
  let problems: ProblemsResult = serde_json::from_value(value["discovery"]["problems"].clone()).unwrap();
  let tree: TreeResult = serde_json::from_value(value["discovery"]["tree"].clone()).unwrap();
  let records = value["swarm"].as_array().unwrap();
  let mut known = 0;
  for value in records {
    if value["event"] == "future_observation" { continue; }
    let mut value = value.clone();
    let object = value.as_object_mut().unwrap();
    object.remove("seq");
    object.remove("at_ms");
    let _: SwarmRecord = serde_json::from_value(value).unwrap();
    known += 1;
  }
  println!("{}", json!({"swarmRecords": known, "discoveryRun": status.run, "problems": problems.problems.len(), "treeNodes": tree.nodes.len()}));
}
