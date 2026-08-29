extends Node
# Fixture only. The key below is fake and exists so the doctor's
# ingest key detection has something to find.

func _ready() -> void:
	Ravensight.ingest_key = "gt_live_FIXTUREFAKE0000000000"
