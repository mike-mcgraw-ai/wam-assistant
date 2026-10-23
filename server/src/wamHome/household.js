/**
 * Public snapshot stand-in. Linking the hub to a WAM Home household is part
 * of WAM Home, which is private; here the link is always off and the hub uses
 * its own stores.
 */
export function createHousehold() {
  return Object.freeze({ enabled: false, ready: false })
}
