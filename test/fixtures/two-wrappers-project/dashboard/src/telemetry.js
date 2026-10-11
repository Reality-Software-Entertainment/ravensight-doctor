import { analytics } from './vendor.js';

export function capture(name, props) {
  window.rs.track(name, props);
}

export function openShop() {
  capture('shop_opened', { from: 'menu' });
  // A call on another receiver is not this wrapper.
  analytics.capture('page_view_from_other_tool');
}
