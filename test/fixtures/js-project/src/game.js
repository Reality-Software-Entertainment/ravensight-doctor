// Fixture game code for ravensight-doctor tests.
import { Ravensight } from "ravensight";

const rs = new Ravensight({ ingestKey: "gt_live_FIXTUREFAKE111111111111111111111" });

export function onLevelCleared(level) {
  rs.track("level_completed", { level });
  rs.track(`level_${level}_cleared`);
}

export function onWeirdEvent() {
  rs.track("way_too_long_event_name_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
}
