import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import protobuf from "protobufjs";
import { generate } from "../scripts/gen-proto.mjs";

// A synthetic module in the same shape as the app's proto.cjs: services with
// methods, classes with a static $() schema, and enums as plain objects.
function fixture() {
  const Color = { 0: "UNSPECIFIED", 1: "RED", UNSPECIFIED: 0, RED: 1 };
  class Inner {
    static $() {
      return ["Inner|1 label 9|2 n 5?"];
    }
  }
  class Req {
    static $() {
      return ["Req|1 id 9|2 tags 9*|3 color #0?|4 inner #1|5 attrs 9,#1|6 items #1*|7 text 9 pick|8 num 5 pick", Color, Inner];
    }
  }
  class Res {
    static $() {
      return ["Res|1 ok 8|2 big 3|3 raw 12"];
    }
  }
  return {
    Color,
    DemoService: {
      typeName: "aiserver.v1.DemoService",
      methods: { doThing: { name: "DoThing", I: Req, O: Res, kind: 0 } },
    },
  };
}

test("generated proto parses and round-trips a message", () => {
  const { proto, rpcs } = generate(fixture());
  const root = protobuf.parse(proto).root;
  const Req = root.lookupType("aiserver.v1.Req");
  const bytes = Req.encode(
    Req.create({ id: "a", tags: ["x", "y"], color: 1, inner: { label: "l" }, attrs: { k: { label: "v" } }, text: "t" }),
  ).finish();
  const back = Req.toObject(Req.decode(bytes), { defaults: false, oneofs: true });
  assert.equal(back.id, "a");
  assert.deepEqual(back.tags, ["x", "y"]);
  assert.equal(back.inner.label, "l");
  assert.equal(back.attrs.k.label, "v");
  assert.equal(back.text, "t");
  assert.deepEqual(rpcs["/aiserver.v1.DemoService/DoThing"], {
    service: "DemoService",
    method: "doThing",
    input: "Req",
    output: "Res",
    kind: 0,
  });
});

test("enum values are prefixed so they cannot collide across enums", () => {
  const { proto } = generate(fixture());
  assert.match(proto, /Color_RED = 1;/);
  assert.match(proto, /Color_UNSPECIFIED = 0;/);
});

test("oneof groups are emitted and optional fields use proto3 optional", () => {
  const { proto } = generate(fixture());
  assert.match(proto, /oneof pick \{/);
  assert.match(proto, /optional Color color = 3;/);
  assert.match(proto, /optional int32 n = 2;/);
});

test("well-known types are imported, not regenerated", () => {
  const mod = fixture();
  class Timestamp {
    static typeName = "google.protobuf.Timestamp";
  }
  class Stamped {
    static $() {
      return ["Stamped|1 at #0|2 maybe #0?", Timestamp];
    }
  }
  mod.DemoService.methods.stamp = { name: "Stamp", I: Stamped, O: mod.DemoService.methods.doThing.O, kind: 0 };
  const { proto } = generate(mod);
  assert.match(proto, /import "google\/protobuf\/timestamp.proto";/);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gen-proto-")), "app.proto");
  fs.writeFileSync(file, proto);
  const root = protobuf.loadSync(file); // loadSync resolves the google/protobuf imports
  const T = root.lookupType("aiserver.v1.Stamped");
  assert.equal(T.fields.at.type, ".google.protobuf.Timestamp");
  const bytes = T.encode(T.create({ at: { seconds: 5, nanos: 1 } })).finish();
  assert.equal(T.decode(bytes).at.seconds.toString(), "5");
});

test("a classless, non-well-known ref fails loudly", () => {
  const mod = fixture();
  mod.DemoService.methods.bad2 = {
    name: "Bad2",
    I: class Mystery {
      static typeName = "vendor.Mystery";
    },
    O: mod.DemoService.methods.doThing.O,
    kind: 0,
  };
  assert.throws(() => generate(mod), /not a well-known type/);
});

test("an unresolvable type fails loudly instead of emitting a bad proto", () => {
  const mod = fixture();
  mod.DemoService.methods.bad = {
    name: "Bad",
    I: class {
      static $() {
        return ["Bad|1 x #3"];
      }
    },
    O: mod.DemoService.methods.doThing.O,
    kind: 0,
  };
  assert.throws(() => generate(mod));
});
