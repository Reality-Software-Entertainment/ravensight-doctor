extends Node
## Fake Ravensight SDK stub for ravensight-doctor tests. Not the real SDK.

var ingest_key := ""

func track(event_name: String, data := {}) -> bool:
	return true

func flush() -> void:
	pass
