// Generates a .proto and an RPC map from the message schemas bundled in the
// desktop app (dist/electron-main/proto.cjs). The app describes each message
// with a compact string, e.g. "Name|1 id 9|2 tags 9*|3 kind #0?", plus the
// classes/enums that "#n" refers to. Nothing from the app is committed: the
// output goes to a git-ignored directory and is rebuilt per installed version.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const SCALARS = {
  1: "double",
  2: "float",
  3: "int64",
  4: "uint64",
  5: "int32",
  6: "fixed64",
  7: "fixed32",
  8: "bool",
  9: "string",
  12: "bytes",
  13: "uint32",
  15: "sfixed32",
  16: "sfixed64",
  17: "sint32",
  18: "sint64",
};

const WELL_KNOWN = {
  "google.protobuf.Timestamp": "google/protobuf/timestamp.proto",
  "google.protobuf.Duration": "google/protobuf/duration.proto",
  "google.protobuf.Empty": "google/protobuf/empty.proto",
  "google.protobuf.Any": "google/protobuf/any.proto",
  "google.protobuf.Struct": "google/protobuf/struct.proto",
  "google.protobuf.Value": "google/protobuf/struct.proto",
  "google.protobuf.ListValue": "google/protobuf/struct.proto",
};

const FIELD =/^(\d+) (\S+) (\S+?)(?: (\S+))?$/;

function isEnum(ref) {
  return ref !== null && typeof ref === "object";
}

export function generate(mod, { services } = {}) {
  const exportedEnums = new Map();
  for (const [name, value] of Object.entries(mod)) {
    if (isEnum(value) && !value.methods) exportedEnums.set(value, name);
  }

  const classNames = new Map(); // class -> message name
  const taken = new Set();
  const uniqueName = (base) => {
    let name = base;
    for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
    taken.add(name);
    return name;
  };
  const enumNames = new Map(); // enum object -> name
  const nameEnum = (e) => {
    if (!enumNames.has(e)) enumNames.set(e, uniqueName(exportedEnums.get(e) ?? `Enum${enumNames.size}`));
    return enumNames.get(e);
  };

  const wanted = Object.entries(mod).filter(
    ([name, svc]) => svc?.methods && (services === undefined || services.includes(name)),
  );
  const queue = [];
  const messages = [];
  const imports = new Set();
  const visit = (cls) => {
    if (typeof cls !== "function" || classNames.has(cls)) return;
    if (typeof cls.$ !== "function") {
      // protobuf well-known types ship without a compact schema but carry a typeName.
      const known = WELL_KNOWN[cls.typeName];
      if (known === undefined) throw new Error(`class without a schema and not a well-known type: ${cls.typeName}`);
      imports.add(known);
      classNames.set(cls, `.${cls.typeName}`);
      return;
    }
    const [header] = cls.$();
    // Nested messages are named "Outer.Inner" in the app; flatten to a legal identifier.
    classNames.set(cls, uniqueName(header.split("|")[0].replaceAll(".", "_")));
    queue.push(cls);
  };

  const rpcs = {};
  for (const [name, svc] of wanted) {
    for (const method of Object.values(svc.methods)) {
      visit(method.I);
      visit(method.O);
    }
  }

  while (queue.length > 0) {
    const cls = queue.shift();
    const [header, ...refs] = cls.$();
    for (const ref of refs) {
      if (isEnum(ref)) nameEnum(ref);
      else visit(ref);
    }
    messages.push({ cls, header, refs });
  }

  const refType = (ref) => (isEnum(ref) ? enumNames.get(ref) : classNames.get(ref));
  const typeOf = (token, refs) =>
    token.replace(/#(\d+)/g, (_, i) => refType(refs[Number(i)])).replace(/^(\d+)$/, (_, n) => SCALARS[n]);

  const out = ['syntax = "proto3";', "package aiserver.v1;", ...[...imports].sort().map((i) => `import "${i}";`), ""];
  for (const { cls, header, refs } of messages) {
    const fields = header.split("|").slice(1);
    const oneofs = new Map();
    const plain = [];
    for (const f of fields) {
      const m = FIELD.exec(f);
      if (!m) throw new Error(`cannot parse field "${f}" in ${header.split("|")[0]}`);
      const [, num, name, rawType, group] = m;
      const repeated = rawType.endsWith("*");
      const optional = rawType.endsWith("?");
      const token = rawType.replace(/[*?]$/, "");
      let type;
      if (token.includes(",")) {
        const [k, v] = token.split(",");
        type = `map<${typeOf(k, refs)}, ${typeOf(v, refs)}>`;
      } else {
        type = typeOf(token, refs);
      }
      if (type.includes("undefined") || SCALARS[type] === undefined && /^\d+$/.test(type)) {
        throw new Error(`unresolved type "${rawType}" in ${header.split("|")[0]}`);
      }
      const prefix = type.startsWith("map<") ? "" : repeated ? "repeated " : optional && !group ? "optional " : "";
      const line = `${prefix}${type} ${name} = ${num};`;
      if (group) {
        if (!oneofs.has(group)) oneofs.set(group, []);
        oneofs.get(group).push(line);
      } else {
        plain.push(line);
      }
    }
    out.push(`message ${classNames.get(cls)} {`);
    for (const l of plain) out.push(`  ${l}`);
    for (const [g, lines] of oneofs) {
      out.push(`  oneof ${g} {`);
      for (const l of lines) out.push(`    ${l}`);
      out.push("  }");
    }
    out.push("}", "");
  }

  for (const [e, name] of enumNames) {
    const values = Object.keys(e)
      .filter((k) => !/^\d+$/.test(k))
      .map((k) => [k, e[k]])
      .sort((a, b) => a[1] - b[1]);
    if (!values.some(([, n]) => n === 0)) values.unshift([`${name}_UNSET`, 0]);
    out.push(`enum ${name} {`);
    for (const [k, n] of values) out.push(`  ${name}_${k} = ${n};`);
    out.push("}", "");
  }

  for (const [name, svc] of wanted) {
    for (const [key, method] of Object.entries(svc.methods)) {
      rpcs[`/${svc.typeName}/${method.name}`] = {
        service: name,
        method: key,
        input: classNames.get(method.I),
        output: classNames.get(method.O),
        kind: method.kind,
      };
    }
  }

  return { proto: out.join("\n"), rpcs, messageCount: messages.length, enumCount: enumNames.size };
}

function defaultAsar() {
  const candidates = [
    process.env.GROKBOT_RESOURCES && path.join(process.env.GROKBOT_RESOURCES, "app.asar"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Grok Bot", "resources", "app.asar"),
    "/opt/Grok Bot/resources/app.asar",
  ];
  return candidates.find((c) => c && fs.existsSync(c));
}

// proto.cjs lives inside the app's asar. Extract just that file into a fresh
// temp directory (never into the repo, and never executed from the cwd).
async function extractProto(asarPath) {
  const asar = await import("@electron/asar");
  const extractFile = asar.extractFile ?? asar.default?.extractFile;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grokbot-proto-"));
  fs.writeFileSync(path.join(dir, "proto.cjs"), extractFile(asarPath, path.join("dist", "electron-main", "proto.cjs")));
  return path.join(dir, "proto.cjs");
}

const isMain =process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const [inputArg, outDir = "generated"] = process.argv.slice(2);
  const input = inputArg ?? defaultAsar();
  if (!input) {
    console.error("usage: node scripts/gen-proto.mjs <app.asar | proto.cjs> [outDir]");
    process.exit(2);
  }
  const protoCjs = input.endsWith(".asar") ? await extractProto(input) : path.resolve(input);
  const mod = createRequire(import.meta.url)(protoCjs);
  const { proto, rpcs, messageCount, enumCount } = generate(mod);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "app.proto"), proto);
  fs.writeFileSync(path.join(outDir, "rpcs.json"), JSON.stringify(rpcs, null, 1));
  console.log(`wrote ${outDir}/app.proto (${messageCount} messages, ${enumCount} enums) and rpcs.json (${Object.keys(rpcs).length} rpcs)`);
}
