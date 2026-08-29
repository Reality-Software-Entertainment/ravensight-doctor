extends CharacterBody2D

var level := 1

func _on_level_cleared() -> void:
	Ravensight.track("level_completed", {"level": level, "deaths": 3})
	Ravensight.track("level_" + str(level))

func _on_boss_fight() -> void:
	Ravensight.track("boss_fight_started")
