import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLoginRouteLocation,
  buildLoginUrl,
  resolvePostLoginNavigation,
} from "../../../frontend/src/utils/authRedirect.js";

test("resolvePostLoginNavigation uses hard navigation for backend routes", () => {
  assert.deepEqual(resolvePostLoginNavigation("/api/files/file-1/download"), {
    type: "hard",
    target: "/api/files/file-1/download",
  });
  assert.deepEqual(resolvePostLoginNavigation("/s/abc123"), {
    type: "hard",
    target: "/s/abc123",
  });
});

test("resolvePostLoginNavigation keeps SPA navigation for app routes and sanitizes invalid next", () => {
  assert.deepEqual(resolvePostLoginNavigation("/users?page=2"), {
    type: "spa",
    target: "/users?page=2",
  });
  assert.deepEqual(resolvePostLoginNavigation("https://evil.example.com"), {
    type: "spa",
    target: "/",
  });
  assert.deepEqual(resolvePostLoginNavigation("javascript:alert(1)"), {
    type: "spa",
    target: "/",
  });
});

test("buildLoginRouteLocation and buildLoginUrl preserve safe next targets", () => {
  assert.deepEqual(buildLoginRouteLocation("/texts?id=1"), {
    path: "/login",
    query: { next: "/texts?id=1" },
  });
  assert.equal(buildLoginUrl("/s/abc123"), "/login?next=%2Fs%2Fabc123");
  assert.equal(buildLoginUrl("https://evil.example.com"), "/login");
});

test("resolvePostLoginNavigation defaults to files root when next is empty", () => {
  assert.deepEqual(resolvePostLoginNavigation(undefined), {
    type: "spa",
    target: "/",
  });
  assert.deepEqual(resolvePostLoginNavigation(""), {
    type: "spa",
    target: "/",
  });
});
