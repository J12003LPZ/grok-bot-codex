// Guards for the plain-HTTP loopback listener. A web page open in the user's
// browser can reach http://localhost:<port>, so the listener must refuse
// anything a browser could send:
//  - DNS rebinding: the Host header must be a loopback name, never a hostname
//    an attacker controls that happens to resolve to 127.0.0.1;
//  - cross-origin fetches: browsers always attach Origin to those, while the
//    desktop app's main-process requests and the box host never do.
// host.docker.internal is how the box container reaches the shim; it is the
// Docker host alias, never a name an attacker can register.
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|host\.docker\.internal)(:\d{1,5})?$/i;

export function checkLoopbackRequest(req) {
  const host = req.headers?.host;
  if (typeof host !== "string" || !LOOPBACK_HOST.test(host)) {
    return { ok: false, status: 403, reason: "host not allowed" };
  }
  if (req.headers.origin !== undefined) {
    return { ok: false, status: 403, reason: "cross-origin request refused" };
  }
  return { ok: true };
}
