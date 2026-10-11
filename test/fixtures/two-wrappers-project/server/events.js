import { rs } from './client.js';

export function capture(userId, name, data) {
  rs.track(name, { userId, ...data });
}

export function onMatchEnd(userId, won) {
  capture(userId, 'match_finished', { won });
  capture(userId, won ? 'playoff_round_cleared' : 'playoff_eliminated');
}
