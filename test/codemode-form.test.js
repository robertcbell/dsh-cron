/**
 * Job form "Code Mode: Default / Off" select (dsh-codemode 0.12.0 run policy).
 * Renders the real JobDialog from lib/client.js with a tiny hook-capable React
 * stub (no DOM), then drives the select and the real submit/postAction path.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function loadDialog() {
	const source = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8")
		.replace("exports.NS = NS;", "exports.NS = NS; exports.__JobDialog = JobDialog;");
	let state = [], index = 0;
	const react = {
		Fragment: "Fragment",
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
		useState(init) { const i = index++; if (!(i in state)) state[i] = typeof init === "function" ? init() : init; return [state[i], (v) => { state[i] = typeof v === "function" ? v(state[i]) : v; }]; },
		useEffect() {}, useRef: (v) => ({ current: v }), useCallback: (f) => f, useMemo: (f) => f(),
	};
	let entry;
	new Function("window", source)({ __ModuleLoader__: { load(v) { entry = v; } }, addEventListener() {}, removeEventListener() {}, dispatchEvent() {} });
	const mod = entry.factory((id) => id === "react" ? react : id === "react-dom" ? { createPortal: (n) => n } : new Proxy({}, { get: () => () => null }));
	return (props) => { index = 0; return mod.__JobDialog(props); };
}
const walk = (node, out = []) => { if (node && typeof node === "object") { if (node.type !== undefined) out.push(node); for (const c of node.children ?? []) walk(c, out); if (node.props?.footer) walk(node.props.footer, out); if (Array.isArray(node)) node.forEach((c) => walk(c, out)); } return out; };
const t = (key) => key;
const codeModeSelect = (tree) => walk(tree).filter((n) => n.type === "select" && n.props["aria-label"] === "form.codeMode");
const presetSelect = (tree) => walk(tree).filter((n) => n.type === "select" && n.props["aria-label"] === "form.preset");
const spec = (task = {}) => ({ name: "nightly", schedule: { cron: "0 9 * * *", timeZone: "UTC" }, task: { kind: "agent", prompt: "report", ...task } });

test("form: Code Mode select renders exactly Default / Off beside the preset select", () => {
	const render = loadDialog();
	const tree = render({ t, initial: undefined, onClose() {}, onSaved() {} });
	const [select] = codeModeSelect(tree);
	assert.ok(select, "select rendered for agent tasks");
	assert.deepEqual(select.children.map((o) => [o.props.value, o.children[0]]), [["default", "form.codeMode.default"], ["off", "form.codeMode.off"]]);
	assert.equal(select.props.value, "default");
	const bar = walk(tree).find((n) => n.props?.className === "dshCron_editorBar" && n.children.includes(presetSelect(tree)[0]));
	assert.equal(bar.children.indexOf(select), bar.children.indexOf(presetSelect(tree)[0]) + 1, "immediately after the preset field");
	for (const [key, text] of [["form.codeMode.default", "Code Mode: Default"], ["form.codeMode.off", "Code Mode: Off"]]) {
		assert.ok(readFileSync(new URL("../lib/client.js", import.meta.url), "utf8").includes(`"${key}": "${text}"`));
	}
});

test("form: edit backfills Off, unknown values show Default, and submit round-trips the enum (Default omitted)", async () => {
	const posted = [];
	globalThis.location = { origin: "http://localhost" };
	globalThis.fetch = async (_url, options) => { posted.push(JSON.parse(options.body)); return { ok: true, status: 200, json: async () => ({}) }; };
	try {
		const render = loadDialog();
		const fresh = loadDialog();
	globalThis.document = { createElement: () => ({ value: "test-token", append() {}, focus() {}, remove() {}, addEventListener(_n, fn) { this.onClose = fn; }, showModal() { this.returnValue = "confirm"; this.onClose(); } }), body: { append() {} }, querySelector: () => null, querySelectorAll: () => [], documentElement: {} };
		assert.equal(codeModeSelect(render({ t, initial: spec({ codeMode: "off" }), onClose() {}, onSaved() {} }))[0].props.value, "off");
		assert.equal(codeModeSelect(fresh({ t, initial: spec({ codeMode: "bogus" }), onClose() {}, onSaved() {} }))[0].props.value, "default");
		const submitOf = (tree) => walk(tree).find((n) => n.props?.variant === "primary").props.onClick;
		await submitOf(fresh({ t, initial: spec(), onClose() {}, onSaved() {} }))();
		assert.equal("codeMode" in posted.at(-1).spec.task, false, "Default is omitted so unchanged specs keep their digest");
		codeModeSelect(fresh({ t, initial: spec(), onClose() {}, onSaved() {} }))[0].props.onChange({ target: { value: "off" } });
		await submitOf(fresh({ t, initial: spec(), onClose() {}, onSaved() {} }))();
		assert.equal(posted.at(-1).spec.task.codeMode, "off");
	} finally { delete globalThis.document; delete globalThis.fetch; delete globalThis.location; }
});
