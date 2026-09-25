# Font-resource investigation: raw `TextNode → TextToVector` failure and the path forward

**Date:** 2026-09-22 · **Status:** investigation + recommendation (no fork changes made; none needed)
**Engine:** pinned upstream `d7ae6029e0c1818d81a13b0389ef1808496a715b`, clean tree, binary sha256 `1a45054d…35dbc7`
**Inputs:** graphite-eval trial (`TRIAL-FINDINGS.md` §4, `p4-direct-*` evidence) · pinned-source recon (file:line citations below) · **execution verification performed this session with the pinned CLI**

## 1. Symptom (from the trial)

A hand-authored `graphene_std::text::TextNode → graphene_std::text::TextToVectorNode` chain compiled but failed at runtime:

```
GraphError … identifier: "input_adapter<Resource>"
Input 3: found Resource; expected Resource
Input 3: found Resource; expected Resource[]
```

The `StringValue → TextToVector` chain (no explicit font) rendered correctly in the same build. Upstream issue #4155 is the known context.

## 2. Root cause (pinned source, verified)

- `TextNode`'s third parameter (serialized input index 2; displayed "Input 3" because display indices are 1-based) is the font input: `font: Item<Resource>` — `node-graph/nodes/gstd/src/text.rs:11-63`, `use …resource::Resource` at line 4. The serialized inputs array is primary + params in order; index 2 is the font slot.
- The trial's `p4-direct-text.graphite` serialized that slot as bare `{"TypeDefault": {"Concrete": {"name": "graphene_resource::Resource"}}}` — the right type name, the wrong **rank**. `TaggedValue::ty()` returns the stored payload verbatim for `TypeDefault` (`graph-craft/src/document/value.rs:300-302`), so the wire type stayed bare `Concrete(Resource)`.
- The font connector is a ranked field, so the preprocessor auto-inserts an `input_adapter<Resource>` node (`preprocessor/src/lib.rs:183-200`, `format!("input_adapter<{element_name}>")` — hence the error's identifier).
- `input_adapter<Resource>` registers exactly two passthrough rows: `Item<Resource>` and `List<Resource>` (`interpreted-executor/src/node_registry.rs:158-163`; `Resource` is in the ranked-value-types list, registration ~line 404). Bare `Resource` matches neither row.
- The two error lines are those two rows' expectations, both mismatched against the one bare wire value. They display nonsensically because `Type`'s `Display` renders `Item<T>` as bare `T` and `List<T>` as `T[]` (`libraries/core-types/src/types.rs:610-620`) — so "expected Resource" means `Item<Resource>` and "expected Resource[]" means `List<Resource>`. Not two different Resources: one bare wire value against two adapter rows.

## 3. The authoring-only fix — **executed and verified this session**

Serialize the font input as the **Item-wrapped** `TypeDefault` (the exact shape the editor itself writes — `editor/src/messages/portfolio/document/node_graph/node_properties.rs:1361` uses `TaggedValue::TypeDefault(item!(Resource))`; round-trip precedent `editor/.../storage_tests/round_trip_tests.rs:556`):

```json
{"Value": {"tagged_value": {"TypeDefault": {"Item": {"Concrete": {"name": "graphene_resource::Resource"}}}}, "exposed": false}}
```

End-to-end mechanism (each step verified in source):
1. Wire type becomes `Item(Concrete("graphene_resource::Resource"))` → matches the adapter's `Item<Resource>` passthrough row (`TypeDescriptor::eq` compares by name when one side lacks a registry id, `types.rs:296-303`).
2. `TypeDefault(Item(Concrete(Resource)))` materializes `Item::<Resource>::default()` — an **empty** resource — via the `for_each_item_type_default!` list, which includes `Resource` (`value.rs:33-44`, `to_dynany` arms `value.rs:176-185`).
3. `TextNode` skips the font attribute when the resource is default: `if font != Resource::default() { item.set_attribute(ATTR_FONT, font) }` (`gstd/text.rs:72-74`).
4. The shaper falls back to the embedded font when no `ATTR_FONT` is attached: `nodes/text/src/to_path.rs:43-47` → `FALLBACK_FONT_RESOURCE` (`fallback.rs` embeds `source-sans-pro-regular.ttf`).

**Execution evidence (pinned binary, this session, 2026-09-22 ~16:54):** `p4-direct-text.graphite` patched only at input index 2 → `graphene-cli compile` **exit 0** → `graphene-cli export --width 1000 --height 500` → SIGSEGV-after-write (as always) → artifact validated: `tmp/direct-text-itemwrapped.png`, 1000×500 PNG, 14,420 bytes, **17 unique RGB colors** — the same diversity profile as the trial's proven text fixture. Proof documents kept: `tmp/p4-direct-text-itemwrapped.graphite` (gitignored tmp/; the shape is now shipped in the `text-on-background` template).

## 4. Real (embedded) fonts — not authorable in legacy JSON

- No `TaggedValue` variant carries font bytes (only `ResourceHash`, `value.rs:95-98, 276`); a TTF cannot ride through a JSON string (`StringToBytesNode` is text-only) and `LoadResourceNode` is HTTP-only (`gstd/src/platform_application_io.rs:120-160`).
- The durable route is the **`.gdd` archive format**: the CLI opens `.gdd` with a resource registry (`graphene-cli/src/main.rs:131-141`), injects a resource proxy (`main.rs:169`), and resolves resource ids to content-addressed hashes at preprocess (`main.rs:277-281`; `document/format/src/resource.rs:26-44`, `add_resource(id, bytes)` → `resources/<hash>`).
- Legacy `.graphite` documents preprocess against an **empty registry** (`main.rs:281`, closure `|_| None`) — any resource-id-referencing font in a legacy document resolves to nothing. This is the most plausible mechanism behind upstream #4155.

## 5. Recommendation

1. **v1 posture (shipped): fallback-font only.** The `text-on-background` template uses the `TextNode` route with the empty-`Item<Resource>` font default — fallback font guaranteed, zero fork work, deterministic. The brief's no-brand-typography constraint holds by design.
2. **Authoring-shape fix adopted (execution-verified).** Wherever an `Item<Resource>` input appears (`TextNode` font, `ImageNode` resource — `raster_nodes/std_nodes.rs:256-266`), serialize as Item-wrapped `TypeDefault`. This is a template/builder convention, not an engine change.
3. **Upstream-tracking posture, no fork.** There is nothing to patch in Rust: the failure was authoring-shape, not engine code. Keep #4155 tracked; if the studio ever needs embedded brand fonts, the follow-up is a bounded `.gdd` resource trial (`add_resource` + registry resolution), NOT a node fork. Do not inline font bytes in JSON — the format cannot carry them.
4. **Residual risk:** the fix's chain is execution-verified for the fallback path; custom-font delivery via `.gdd` is untested (explicitly out of scope this build — non-goal).

*Investigation basis: studio.scout pinned-source recon (all citations spot-verified by the director: `text.rs:21` `font: Item<Resource>`; `adjustments.rs:1167` gradient_map exists; registry line numbers) + director's execution verification above.*
