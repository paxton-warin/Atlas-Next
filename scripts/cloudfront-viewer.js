// CloudFront Function, viewer-request, JavaScript runtime 2.0.
// Pair with AllViewerExceptHostHeader and HTTPS-only viewers.
function handler(event) {
  var request = event.request;
  request.headers['x-atlas-viewer-host'] = { value: request.headers.host.value };
  request.headers['x-atlas-viewer-ip'] = { value: event.viewer.ip };
  request.headers['x-atlas-viewer-proto'] = { value: 'https' };
  return request;
}
