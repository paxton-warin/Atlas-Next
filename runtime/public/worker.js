importScripts("/controller/controller.worker.js");

addEventListener("fetch", (event) => {
  if (self.$runtimekitController.shouldRoute(event)) {
    event.respondWith(self.$runtimekitController.route(event));
  }
});
