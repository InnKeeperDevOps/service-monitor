import test from "node:test";
import assert from "node:assert/strict";

import {
  parseStableSemverTag,
  selectLatestVersionFromTags,
  bumpVersion
} from "../bump-version-from-tags.mjs";

test("parseStableSemverTag extracts x.y.z from v-prefixed tags", () => {
  assert.equal(parseStableSemverTag("v1.2.3"), "1.2.3");
});

test("parseStableSemverTag returns null for non-stable tags", () => {
  assert.equal(parseStableSemverTag("release-1.2.3"), null);
  assert.equal(parseStableSemverTag("v1.2.3-rc.1"), null);
});

test("selectLatestVersionFromTags returns highest stable semver", () => {
  const tags = ["v0.1.2", "v0.3.0", "v0.2.9", "foo", "v2.0.0"];
  assert.equal(selectLatestVersionFromTags(tags), "2.0.0");
});

test("bumpVersion increments semantic versions by level", () => {
  assert.equal(bumpVersion("1.2.3", "patch"), "1.2.4");
  assert.equal(bumpVersion("1.2.3", "minor"), "1.3.0");
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
});
