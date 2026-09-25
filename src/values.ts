/**
 * Document vocabulary for hand-authored .graphite documents.
 *
 * The engine's document format is a Rust serde JSON tree (TaggedValue inputs,
 * ProtoNode/Network implementations, editor-state scaffolding). This module is
 * the single place that knows how to SPEAK that format: typed input builders,
 * the two wrapper networks, and the document assembly epilogue.
 *
 * GROUND TRUTH POLICY — copy, don't improvise. Every `*_VERBATIM` constant and
 * every input-order comment is extracted from a proven, execution-verified
 * document:
 *   - `p4-hand-authored.graphite` + `p5-custom-duotone.graphite`
 *     (graphite-eval trials: compiled + headless-rendered by graphene-cli;
 *     verbatim copies live in `tests/fixtures/`),
 *   - `tmp/p4-direct-text-itemwrapped.graphite` (Text-node chain compiled AND
 *     rendered by the pinned CLI — proof artifact `tmp/direct-text-itemwrapped.png`),
 *   - the pinned engine's working demo artwork
 *     (`graphite-eval/Graphite/demo-artwork/`: `marbled-mandelbrot.graphite`
 *     for the NoisePattern→GradientMap chain and NoisePattern's full 16-input
 *     serialization; `parametric-dunescape.graphite` for the
 *     Rectangle→Fill gradient route and GradientRamp serialization).
 *
 * Node-input indices are cross-checked against the pinned clone's source
 * (`node-graph/nodes/...`) and the real CLI's `list-node-identifiers` output.
 */

// ---------------------------------------------------------------------------
// Typed values
// ---------------------------------------------------------------------------

/** Linear-space RGB color with all channels in 0..1 (`linear: true` on wire). */
export interface RgbColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
  linear: true;
}

/** Serialized color: exact key order matches the proven fixtures. */
export interface SerializedColor {
  red: number;
  green: number;
  blue: number;
  alpha: number;
  linear: boolean;
}

/**
 * A serialized TaggedValue wrapped as a node input.
 * Shape (verbatim convention): `{"Value": {"tagged_value": <tagged>, "exposed": false}}`.
 */
export interface ValueInput {
  Value: { tagged_value: unknown; exposed: boolean };
}

/** A connection to another node's output. */
export interface NodeInput {
  Node: { node_id: number; output_index: number };
}

/** An import inside a nested network (used by the wrapper boilerplate). */
export interface ImportInput {
  Import: {
    import_type:
      | { Generic: string }
      | { Concrete: { name: string } }
      | { Item: { Concrete: { name: string } } }
      | { Fn: unknown[] };
    import_index: number;
  };
}

/** All input kinds that appear in hand-authored documents. */
export type DocInput = ValueInput | NodeInput | ImportInput;

/** A node inside a network: `[[nodeId, nodeEntry], ...]` tuples on the wire. */
export interface DocNodeEntry {
  inputs: DocInput[];
  call_argument: unknown;
  implementation: { ProtoNode: { name: string } } | { Network: NetworkImplementation };
  visible: boolean;
  skip_deduplication: boolean;
  context_features: { extract: string; inject: string };
}

/** A nested Network implementation (the wrapper boilerplate shape). */
export interface NetworkImplementation {
  exports: Array<{ Node: { node_id: number; output_index: number } }>;
  nodes: Array<[number, DocNodeEntry]>;
  scope_injections: unknown[];
}

/** The top-level `.graphite` document object. */
export interface GraphiteDocument {
  network_interface: {
    network: {
      exports: Array<{ Node: { node_id: number; output_index: number } }>;
      nodes: Array<[number, DocNodeEntry]>;
    };
    network_metadata: unknown;
  };
  [editorStateKey: string]: unknown;
}

// ---------------------------------------------------------------------------
// Input builders (serialization order copied from the proven fixtures)
// ---------------------------------------------------------------------------

/**
 * Builds a serialized linear-RGB color. Key order `red, green, blue, alpha,
 * linear` matches both trial fixtures and the demo artwork.
 */
export function serializedColor(color: RgbColor): SerializedColor {
  return {
    red: color.red,
    green: color.green,
    blue: color.blue,
    alpha: color.alpha,
    linear: color.linear,
  };
}

function valueInput(tagged: unknown): ValueInput {
  return { Value: { tagged_value: tagged, exposed: false } };
}

export function colorValue(color: RgbColor): ValueInput {
  // TaggedValue is an externally-tagged enum: the payload must sit under the
  // variant key (proven: {"Color": {"red": ..., "linear": true}} in every
  // fixture and the demo artwork).
  return valueInput({ Color: serializedColor(color) });
}

/**
 * Two-stop gradient. Serialization verified against the working demo
 * `parametric-dunescape.graphite` (and the `_backup_gradient` slot of every
 * proven Fill node): positions 0/1, midpoints 0.5, RgbGamma space.
 */
export function gradientRampValue(stops: [RgbColor, RgbColor]): ValueInput {
  return valueInput({
    GradientRamp: {
      stops: {
        color: [serializedColor(stops[0]), serializedColor(stops[1])],
        position: [0.0, 1.0],
        midpoint: [0.5, 0.5],
      },
      gradient_space: 'RgbGamma',
    },
  });
}

export function dAffine2Value(matrix: readonly number[]): ValueInput {
  return valueInput({ DAffine2: [...matrix] });
}

export function dVec2Value(x: number, y: number): ValueInput {
  return valueInput({ DVec2: [x, y] });
}

export function boolValue(b: boolean): ValueInput {
  return valueInput({ Bool: b });
}

export function f64Value(n: number): ValueInput {
  return valueInput({ F64: n });
}

export function u32Value(n: number): ValueInput {
  return valueInput({ U32: n });
}

export function stringValue(s: string): ValueInput {
  return valueInput({ String: s });
}

/**
 * The "no primary input" marker. TWO proven spellings exist:
 *  - bare string `"None"` — used by the demo's RectangleNode / NoisePatternNode;
 *  - `{"None": null}` — used by the trial's StringValueNode / TextNode.
 * Copy whichever spelling the surrounding node skeleton was proven with.
 */
export function nonePrimaryValue(): ValueInput {
  return valueInput('None');
}

/** `{"None": null}` spelling of the empty primary input (text-node family). */
export function nullNonePrimaryValue(): ValueInput {
  return valueInput({ None: null });
}

export function nodeInput(nodeId: number, outputIndex = 0): NodeInput {
  return { Node: { node_id: nodeId, output_index: outputIndex } };
}

// ---------------------------------------------------------------------------
// Node entries
// ---------------------------------------------------------------------------

const CONTEXT_CALL_ARGUMENT = {
  Concrete: {
    name: 'core::option::Option<alloc::sync::Arc<core_types::context::OwnedContextImpl>>',
  },
} as const;

/** Builds a ProtoNode entry with the exact boilerplate the trials use. */
export function protoNodeEntry(name: string, inputs: DocInput[]): DocNodeEntry {
  return {
    inputs,
    call_argument: CONTEXT_CALL_ARGUMENT,
    implementation: { ProtoNode: { name } },
    visible: true,
    skip_deduplication: false,
    context_features: { extract: '', inject: '' },
  };
}

/**
 * Verbatim generic graphic wrapper `Network` implementation, extracted from
 * the p4 trial fixture node 104 (identical in p5 node 103 and the demo
 * artwork). Filled per-use by `genericWrapperNode`.
 */
const GENERIC_GRAPHIC_WRAPPER_IMPL: NetworkImplementation = {
  "exports": [
    {
      "Node": {
        "node_id": 5,
        "output_index": 0
      }
    }
  ],
  "nodes": [
    [
      0,
      {
        "inputs": [
          {
            "Import": {
              "import_type": {
                "Generic": "T"
              },
              "import_index": 0
            }
          }
        ],
        "call_argument": {
          "Concrete": {
            "name": "core::option::Option<alloc::sync::Arc<core_types::context::OwnedContextImpl>>"
          }
        },
        "implementation": {
          "ProtoNode": {
            "name": "graphic_nodes::graphic::AsGraphicNode"
          }
        },
        "visible": true,
        "skip_deduplication": false,
        "context_features": {
          "extract": "",
          "inject": ""
        }
      }
    ],
    [
      1,
      {
        "inputs": [
          {
            "Import": {
              "import_type": {
                "Generic": "T"
              },
              "import_index": 1
            }
          }
        ],
        "call_argument": {
          "Concrete": {
            "name": "core::option::Option<alloc::sync::Arc<core_types::context::OwnedContextImpl>>"
          }
        },
        "implementation": {
          "ProtoNode": {
            "name": "graphic_nodes::graphic::IntoGroupNode"
          }
        },
        "visible": true,
        "skip_deduplication": false,
        "context_features": {
          "extract": "",
          "inject": ""
        }
      }
    ],
    [
      2,
      {
        "inputs": [
          {
            "Reflection": "DocumentNodePath"
          }
        ],
        "call_argument": {
          "Concrete": {
            "name": "core::option::Option<alloc::sync::Arc<core_types::context::OwnedContextImpl>>"
          }
        },
        "implementation": {
          "ProtoNode": {
            "name": "graphic_nodes::graphic::PathOfSubgraphNode"
          }
        },
        "visible": true,
        "skip_deduplication": false,
        "context_features": {
          "extract": "",
          "inject": ""
        }
      }
    ],
    [
      3,
      {
        "inputs": [
          {
            "Node": {
              "node_id": 1,
              "output_index": 0
            }
          },
          {
            "Value": {
              "tagged_value": {
                "String": "editor:layer_path"
              },
              "exposed": false
            }
          },
          {
            "Node": {
              "node_id": 2,
              "output_index": 0
            }
          }
        ],
        "call_argument": {
          "Concrete": {
            "name": "core::option::Option<alloc::sync::Arc<core_types::context::OwnedContextImpl>>"
          }
        },
        "implementation": {
          "ProtoNode": {
            "name": "graphic_nodes::graphic::WriteAttributeNode"
          }
        },
        "visible": true,
        "skip_deduplication": false,
        "context_features": {
          "extract": "",
          "inject": ""
        }
      }
    ],
    [
      4,
      {
        "inputs": [
          {
            "Node": {
              "node_id": 3,
              "output_index": 0
            }
          }
        ],
        "call_argument": {
          "Concrete": {
            "name": "core::option::Option<alloc::sync::Arc<core_types::context::OwnedContextImpl>>"
          }
        },
        "implementation": {
          "ProtoNode": {
            "name": "graphene_core::memo::MonitorNode"
          }
        },
        "visible": true,
        "skip_deduplication": true,
        "context_features": {
          "extract": "",
          "inject": ""
        }
      }
    ],
    [
      5,
      {
        "inputs": [
          {
            "Node": {
              "node_id": 0,
              "output_index": 0
            }
          },
          {
            "Node": {
              "node_id": 4,
              "output_index": 0
            }
          }
        ],
        "call_argument": {
          "Generic": "T"
        },
        "implementation": {
          "ProtoNode": {
            "name": "graphic_nodes::graphic::ExtendNode"
          }
        },
        "visible": true,
        "skip_deduplication": false,
        "context_features": {
          "extract": "",
          "inject": ""
        }
      }
    ]
  ],
  "scope_injections": []
} as NetworkImplementation;


/**
 * The generic graphic wrapper (verbatim `Network` implementation): the
 * AsGraphic → IntoGroup → PathOfSubgraph → WriteAttribute → Monitor → Extend
 * chain stamped with `editor:layer_path`, exported through node 5.
 * IDENTICAL across p4, p5 and the demo artwork (byte-for-byte modulo the
 * content node reference, which `genericWrapperNode` fills in).
 */
export function genericWrapperNode(contentNodeId: number): DocNodeEntry {
  const node: DocNodeEntry = {
    inputs: [
      // [0] TypeDefault: List<Graphic> — exposed, marks the wrapper's import type
      {
        Value: {
          tagged_value: { TypeDefault: { List: { Concrete: { name: 'graphic_types::graphic::Graphic' } } } },
          exposed: true,
        },
      },
      // [1] the content graphic
      nodeInput(contentNodeId),
    ],
    call_argument: { Generic: 'T' },
    implementation: { Network: structuredClone(GENERIC_GRAPHIC_WRAPPER_IMPL) },
    visible: true,
    skip_deduplication: false,
    context_features: { extract: '', inject: '' },
  };
  return node;
}

/**
 * Verbatim CreateArtboard wrapper `Network` implementation, extracted from
 * the p4 trial fixture node 105 (identical in p5 node 104 and the demo
 * artwork). Filled per-use by `artboardWrapperNode`.
 */
const CREATE_ARTBOARD_WRAPPER_IMPL: NetworkImplementation = {
  "exports": [
    {
      "Node": {
        "node_id": 4,
        "output_index": 0
      }
    }
  ],
  "nodes": [
    [
      0,
      {
        "inputs": [
          {
            "Import": {
              "import_type": {
                "Fn": [
                  {
                    "Concrete": {
                      "name": "core::option::Option<alloc::sync::Arc<core_types::context::OwnedContextImpl>>"
                    }
                  },
                  {
                    "Generic": "T"
                  }
                ]
              },
              "import_index": 1
            }
          },
          {
            "Import": {
              "import_type": {
                "Item": {
                  "Concrete": {
                    "name": "graph_craft::document::value::TaggedValue"
                  }
                }
              },
              "import_index": 2
            }
          },
          {
            "Import": {
              "import_type": {
                "Item": {
                  "Concrete": {
                    "name": "graph_craft::document::value::TaggedValue"
                  }
                }
              },
              "import_index": 3
            }
          },
          {
            "Import": {
              "import_type": {
                "Item": {
                  "Concrete": {
                    "name": "graph_craft::document::value::TaggedValue"
                  }
                }
              },
              "import_index": 4
            }
          },
          {
            "Import": {
              "import_type": {
                "Item": {
                  "Concrete": {
                    "name": "graph_craft::document::value::TaggedValue"
                  }
                }
              },
              "import_index": 5
            }
          }
        ],
        "call_argument": {
          "Generic": "T"
        },
        "implementation": {
          "ProtoNode": {
            "name": "graphic_nodes::artboard::CreateArtboardNode"
          }
        },
        "visible": true,
        "skip_deduplication": false,
        "context_features": {
          "extract": "",
          "inject": ""
        }
      }
    ],
    [
      1,
      {
        "inputs": [
          {
            "Reflection": "DocumentNodePath"
          }
        ],
        "call_argument": {
          "Concrete": {
            "name": "core::option::Option<alloc::sync::Arc<core_types::context::OwnedContextImpl>>"
          }
        },
        "implementation": {
          "ProtoNode": {
            "name": "graphic_nodes::graphic::PathOfSubgraphNode"
          }
        },
        "visible": true,
        "skip_deduplication": false,
        "context_features": {
          "extract": "",
          "inject": ""
        }
      }
    ],
    [
      2,
      {
        "inputs": [
          {
            "Node": {
              "node_id": 0,
              "output_index": 0
            }
          },
          {
            "Value": {
              "tagged_value": {
                "String": "editor:layer_path"
              },
              "exposed": false
            }
          },
          {
            "Node": {
              "node_id": 1,
              "output_index": 0
            }
          }
        ],
        "call_argument": {
          "Concrete": {
            "name": "core::option::Option<alloc::sync::Arc<core_types::context::OwnedContextImpl>>"
          }
        },
        "implementation": {
          "ProtoNode": {
            "name": "graphic_nodes::graphic::WriteAttributeNode"
          }
        },
        "visible": true,
        "skip_deduplication": false,
        "context_features": {
          "extract": "",
          "inject": ""
        }
      }
    ],
    [
      3,
      {
        "inputs": [
          {
            "Node": {
              "node_id": 2,
              "output_index": 0
            }
          }
        ],
        "call_argument": {
          "Concrete": {
            "name": "core::option::Option<alloc::sync::Arc<core_types::context::OwnedContextImpl>>"
          }
        },
        "implementation": {
          "ProtoNode": {
            "name": "graphene_core::memo::MonitorNode"
          }
        },
        "visible": true,
        "skip_deduplication": true,
        "context_features": {
          "extract": "",
          "inject": ""
        }
      }
    ],
    [
      4,
      {
        "inputs": [
          {
            "Import": {
              "import_type": {
                "Fn": [
                  {
                    "Concrete": {
                      "name": "core::option::Option<alloc::sync::Arc<core_types::context::OwnedContextImpl>>"
                    }
                  },
                  {
                    "List": {
                      "Concrete": {
                        "name": "graphic_types::artboard::Artboard"
                      }
                    }
                  }
                ]
              },
              "import_index": 0
            }
          },
          {
            "Node": {
              "node_id": 3,
              "output_index": 0
            }
          }
        ],
        "call_argument": {
          "Concrete": {
            "name": "core::option::Option<alloc::sync::Arc<core_types::context::OwnedContextImpl>>"
          }
        },
        "implementation": {
          "ProtoNode": {
            "name": "graphic_nodes::graphic::ExtendNode"
          }
        },
        "visible": true,
        "skip_deduplication": false,
        "context_features": {
          "extract": "",
          "inject": ""
        }
      }
    ]
  ],
  "scope_injections": []
} as NetworkImplementation;


export interface ArtboardOptions {
  /** Artboard origin in document space. Proven trials use [0, 0]. */
  x?: number;
  y?: number;
  /** Artboard dimensions in document pixels. Both are always required. */
  width: number;
  height: number;
  /** Artboard background color (renders wherever no layer covers). */
  background: RgbColor;
}

/**
 * The CreateArtboard wrapper (verbatim `Network` implementation):
 * CreateArtboard → PathOfSubgraph → WriteAttribute → Monitor → Extend,
 * exported through node 4. IDENTICAL across p4, p5 and the demo artwork.
 */
export function artboardWrapperNode(contentNodeId: number, options: ArtboardOptions): DocNodeEntry {
  return {
    inputs: [
      // [0] TypeDefault: List<Artboard> — exposed, marks the wrapper's import type
      {
        Value: {
          tagged_value: { TypeDefault: { List: { Concrete: { name: 'graphic_types::artboard::Artboard' } } } },
          exposed: true,
        },
      },
      // [1] the content graphic (the wrapped layer)
      nodeInput(contentNodeId),
      // [2] artboard origin
      dVec2Value(options.x ?? 0, options.y ?? 0),
      // [3] artboard dimensions
      dVec2Value(options.width, options.height),
      // [4] artboard background color
      colorValue(options.background),
      // [5] clip-enabled flag (trials and demo both send true)
      boolValue(true),
    ],
    call_argument: { Generic: 'T' },
    implementation: { Network: structuredClone(CREATE_ARTBOARD_WRAPPER_IMPL) },
    visible: true,
    skip_deduplication: false,
    context_features: { extract: '', inject: '' },
  };
}

/**
 * Verbatim Monitor+Transform wrapper `Network` implementation, extracted from
 * the working demo `marbled-mandelbrot.graphite` (node 6029481207635803402,
 * which positions the Mandelbrot raster). The Transform node is the engine's
 * placement primitive: it composes translation/rotation/scale/skew onto the
 * content AND its rendering footprint. Used to move content that generates
 * geometry centered at the origin (e.g. RectangleNode) to the artboard area.
 */
const MONITOR_TRANSFORM_WRAPPER_IMPL: NetworkImplementation = {
  exports: [{ Node: { node_id: 1, output_index: 0 } }],
  nodes: [
    [
      0,
      {
        inputs: [
          {
            Import: {
              import_type: { Generic: 'T' },
              import_index: 0,
            },
          },
        ],
        call_argument: {
          Concrete: {
            name: 'core::option::Option<alloc::sync::Arc<core_types::context::OwnedContextImpl>>',
          },
        },
        implementation: { ProtoNode: { name: 'graphene_core::memo::MonitorNode' } },
        visible: true,
        skip_deduplication: true,
        context_features: { extract: '', inject: '' },
      },
    ],
    [
      1,
      {
        inputs: [
          { Node: { node_id: 0, output_index: 0 } },
          {
            Import: {
              import_type: { Concrete: { name: 'glam::f64::dvec2::DVec2' } },
              import_index: 1,
            },
          },
          {
            Import: {
              import_type: { Concrete: { name: 'f64' } },
              import_index: 2,
            },
          },
          {
            Import: {
              import_type: { Concrete: { name: 'glam::f64::dvec2::DVec2' } },
              import_index: 3,
            },
          },
          {
            Import: {
              import_type: { Concrete: { name: 'glam::f64::dvec2::DVec2' } },
              import_index: 4,
            },
          },
        ],
        call_argument: {
          Concrete: {
            name: 'core::option::Option<alloc::sync::Arc<core_types::context::OwnedContextImpl>>',
          },
        },
        implementation: { ProtoNode: { name: 'transform_nodes::transform_nodes::TransformNode' } },
        visible: true,
        skip_deduplication: false,
        context_features: { extract: '', inject: '' },
      },
    ],
  ],
  scope_injections: [],
};

export interface TransformOptions {
  translation: readonly [number, number];
  /** Degrees. */
  rotation?: number;
  scale?: readonly [number, number];
}

/**
 * Builds the Monitor+Transform wrapper outer node with the demo's proven
 * 7-input shape: content, translation, rotation, scale, skew, plus the demo's
 * two trailing inert inputs (DVec2 [0,0] and Bool true) copied verbatim.
 */
export function monitorTransformWrapperNode(contentNodeId: number, options: TransformOptions): DocNodeEntry {
  return {
    inputs: [
      // [0] content
      nodeInput(contentNodeId),
      // [1] translation
      dVec2Value(options.translation[0], options.translation[1]),
      // [2] rotation (degrees)
      f64Value(options.rotation ?? 0),
      // [3] scale
      dVec2Value(options.scale?.[0] ?? 1, options.scale?.[1] ?? 1),
      // [4] skew (demo sends [0,0])
      dVec2Value(0, 0),
      // [5] extra trailing input, demo-verbatim (DVec2 [0,0])
      dVec2Value(0, 0),
      // [6] extra trailing input, demo-verbatim (Bool true)
      boolValue(true),
    ],
    call_argument: { Generic: 'T' },
    implementation: { Network: structuredClone(MONITOR_TRANSFORM_WRAPPER_IMPL) },
    visible: true,
    skip_deduplication: false,
    context_features: { extract: '', inject: '' },
  };
}

/**
 * Verbatim editor-state scaffold fields (every top-level key except
 * `network_interface`), extracted from the p4 trial fixture. IDENTICAL in the
 * p5 trial and the director-verified TextNode document — editor-only state,
 * inert for headless compilation and rendering.
 */
const DOCUMENT_SCAFFOLD_FIELDS: Record<string, unknown> = {
  "collapsed": [],
  "properties_panel_collapsed_sections": [],
  "commit_hash": "",
  "document_ptz": {
    "pan": [
      -339.3903349049215,
      -502.62390663267854
    ],
    "tilt": 0.0,
    "zoom": 4.0,
    "flip": false
  },
  "render_mode": "Normal",
  "overlays_visibility_settings": {
    "all": true,
    "artboard_name": true,
    "compass_rose": true,
    "quick_measurement": true,
    "transform_measurement": true,
    "transform_cage": true,
    "hover_outline": true,
    "selection_outline": true,
    "layer_origin_cross": true,
    "pivot": true,
    "origin": true,
    "path": true,
    "anchors": true,
    "handles": true
  },
  "rulers_visible": true,
  "snapping_state": {
    "snapping_enabled": true,
    "grid_snapping": false,
    "artboards": true,
    "tolerance": 8.0,
    "bounding_box": {
      "center_point": true,
      "corner_point": true,
      "edge_midpoint": true,
      "align_with_edges": true,
      "distribute_evenly": true
    },
    "path": {
      "anchor_point": true,
      "line_midpoint": true,
      "along_path": true,
      "normal_to_path": true,
      "tangent_to_path": true,
      "path_intersection_point": true,
      "align_with_anchor_point": true,
      "perpendicular_from_endpoint": true
    },
    "grid": {
      "origin": [
        0.0,
        0.0
      ],
      "grid_type": {
        "Rectangular": {
          "spacing": [
            1.0,
            1.0
          ]
        }
      },
      "rectangular_spacing": [
        1.0,
        1.0
      ],
      "isometric_y_spacing": 1.0,
      "isometric_angle_a": 30.0,
      "isometric_angle_b": 30.0,
      "color": "#cccccc",
      "dot_display": false
    }
  },
  "graph_view_overlay_open": false,
  "graph_fade_artwork_percentage": 80.0
};

/**
 * Verbatim `network_metadata` (editor display names etc.), identical across
 * p4, p5 and the director-verified TextNode document. Proven inert for
 * headless use: the text-chain document rendered fine carrying the trial's
 * "Gradient Map" metadata.
 */
const NETWORK_METADATA: unknown = {
  "persistent_metadata": {
    "reference": null,
    "node_metadata": [
      [
        80924370013313595,
        {
          "persistent_metadata": {
            "display_name": "Gradient Map",
            "input_metadata": [
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": null,
                  "input_name": "Image",
                  "input_description": ""
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": null,
                  "input_name": "Gradient",
                  "input_description": ""
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": null,
                  "input_name": "Reverse",
                  "input_description": ""
                }
              }
            ],
            "output_names": [
              "Image"
            ],
            "locked": false,
            "pinned": false,
            "node_type_metadata": {
              "Node": {
                "position": "Chain"
              }
            },
            "network_metadata": null
          }
        }
      ],
      [
        3606681156406984991,
        {
          "persistent_metadata": {
            "display_name": "Gradient Map",
            "input_metadata": [
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": null,
                  "input_name": "Image",
                  "input_description": ""
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": null,
                  "input_name": "Gradient",
                  "input_description": ""
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": null,
                  "input_name": "Reverse",
                  "input_description": ""
                }
              }
            ],
            "output_names": [
              "Image"
            ],
            "locked": false,
            "pinned": false,
            "node_type_metadata": {
              "Node": {
                "position": "Chain"
              }
            },
            "network_metadata": null
          }
        }
      ],
      [
        4388711862172196665,
        {
          "persistent_metadata": {
            "display_name": "Mandelbrot",
            "input_metadata": [],
            "output_names": [
              "Raster"
            ],
            "locked": false,
            "pinned": false,
            "node_type_metadata": {
              "Node": {
                "position": "Chain"
              }
            },
            "network_metadata": null
          }
        }
      ],
      [
        6029481207635803402,
        {
          "persistent_metadata": {
            "display_name": "Transform",
            "input_metadata": [
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": null,
                  "input_name": "Value",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {
                    "is_integer": false,
                    "unit": " px",
                    "x": "X",
                    "y": "Y"
                  },
                  "widget_override": "vec2",
                  "input_name": "Translation",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "transform_rotation",
                  "input_name": "Rotation",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {
                    "is_integer": false,
                    "unit": "x",
                    "x": "W",
                    "y": "H"
                  },
                  "widget_override": "vec2",
                  "input_name": "Scale",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "transform_skew",
                  "input_name": "Skew",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "hidden",
                  "input_name": "Origin Offset",
                  "input_description": ""
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "hidden",
                  "input_name": "Scale Appearance",
                  "input_description": ""
                }
              }
            ],
            "output_names": [
              "Data"
            ],
            "locked": false,
            "pinned": false,
            "node_type_metadata": {
              "Node": {
                "position": "Chain"
              }
            },
            "network_metadata": {
              "persistent_metadata": {
                "reference": null,
                "node_metadata": [
                  [
                    0,
                    {
                      "persistent_metadata": {
                        "display_name": "Monitor",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "",
                              "input_description": ""
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                0,
                                0
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ],
                  [
                    1,
                    {
                      "persistent_metadata": {
                        "display_name": "Transform",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "",
                              "input_description": ""
                            }
                          },
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "",
                              "input_description": ""
                            }
                          },
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "",
                              "input_description": ""
                            }
                          },
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "",
                              "input_description": ""
                            }
                          },
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "",
                              "input_description": ""
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                7,
                                0
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ]
                ],
                "pinned_node_order": [],
                "previewing": "No",
                "navigation_metadata": {
                  "node_graph_ptz": {
                    "pan": [
                      0.0,
                      0.0
                    ],
                    "tilt": 0.0,
                    "zoom": 1.0,
                    "flip": false
                  },
                  "node_graph_to_viewport": [
                    1.0,
                    0.0,
                    0.0,
                    1.0,
                    0.0,
                    0.0
                  ],
                  "node_graph_width": 0.0
                }
              }
            }
          }
        }
      ],
      [
        6323350524796370485,
        {
          "persistent_metadata": {
            "display_name": "Noise Pattern",
            "input_metadata": [
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": null,
                  "input_name": "Spacer",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": null,
                  "input_name": "Clip",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": null,
                  "input_name": "Seed",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "noise_properties_scale",
                  "input_name": "Scale",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "noise_properties_noise_type",
                  "input_name": "Noise Type",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "noise_properties_domain_warp_type",
                  "input_name": "Domain Warp Type",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "noise_properties_domain_warp_amplitude",
                  "input_name": "Domain Warp Amplitude",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "noise_properties_fractal_type",
                  "input_name": "Fractal Type",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "noise_properties_fractal_octaves",
                  "input_name": "Fractal Octaves",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "noise_properties_fractal_lacunarity",
                  "input_name": "Fractal Lacunarity",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "noise_properties_fractal_gain",
                  "input_name": "Fractal Gain",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "noise_properties_fractal_weighted_strength",
                  "input_name": "Fractal Weighted Strength",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "noise_properties_ping_pong_strength",
                  "input_name": "Fractal Ping Pong Strength",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "noise_properties_cellular_distance_function",
                  "input_name": "Cellular Distance Function",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "noise_properties_cellular_return_type",
                  "input_name": "Cellular Return Type",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "noise_properties_cellular_jitter",
                  "input_name": "Cellular Jitter",
                  "input_description": "TODO"
                }
              }
            ],
            "output_names": [
              "Image"
            ],
            "locked": false,
            "pinned": false,
            "node_type_metadata": {
              "Node": {
                "position": "Chain"
              }
            },
            "network_metadata": null
          }
        }
      ],
      [
        6565638614909771142,
        {
          "persistent_metadata": {
            "display_name": "Mandelbrot Set",
            "input_metadata": [
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": null,
                  "input_name": "Graphical Data",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": null,
                  "input_name": "Over",
                  "input_description": "TODO"
                }
              }
            ],
            "output_names": [
              "Out"
            ],
            "locked": false,
            "pinned": false,
            "node_type_metadata": {
              "Layer": {
                "position": {
                  "Absolute": [
                    -16,
                    6
                  ]
                }
              }
            },
            "network_metadata": {
              "persistent_metadata": {
                "reference": "Merge",
                "node_metadata": [
                  [
                    0,
                    {
                      "persistent_metadata": {
                        "display_name": "",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Value",
                              "input_description": ""
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                -21,
                                -2
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ],
                  [
                    1,
                    {
                      "persistent_metadata": {
                        "display_name": "",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Content",
                              "input_description": ""
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                -21,
                                -1
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ],
                  [
                    2,
                    {
                      "persistent_metadata": {
                        "display_name": "",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Node Path",
                              "input_description": ""
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                -21,
                                0
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ],
                  [
                    3,
                    {
                      "persistent_metadata": {
                        "display_name": "",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Content",
                              "input_description": "The list to set the named attribute on (one value per item).\n"
                            }
                          },
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Name",
                              "input_description": "The attribute name (key) to write or replace.\n"
                            }
                          },
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Value",
                              "input_description": "The node that produces the attribute value for each item. Called once per item with the item's index in context.\n"
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                -14,
                                -1
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ],
                  [
                    4,
                    {
                      "persistent_metadata": {
                        "display_name": "",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Content",
                              "input_description": ""
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                -7,
                                -1
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ],
                  [
                    5,
                    {
                      "persistent_metadata": {
                        "display_name": "",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Base",
                              "input_description": "The list whose items will appear at the start of the extended list.\n"
                            }
                          },
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "New",
                              "input_description": "The list whose items will appear at the end of the extended list.\n"
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                0,
                                -2
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ]
                ],
                "pinned_node_order": [],
                "previewing": "No",
                "navigation_metadata": {
                  "node_graph_ptz": {
                    "pan": [
                      0.0,
                      0.0
                    ],
                    "tilt": 0.0,
                    "zoom": 1.0,
                    "flip": false
                  },
                  "node_graph_to_viewport": [
                    1.0,
                    0.0,
                    0.0,
                    1.0,
                    0.0,
                    0.0
                  ],
                  "node_graph_width": 0.0
                }
              }
            }
          }
        }
      ],
      [
        7624113397561636853,
        {
          "persistent_metadata": {
            "display_name": "Swirly Noise",
            "input_metadata": [
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": null,
                  "input_name": "Graphical Data",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": null,
                  "input_name": "Over",
                  "input_description": "TODO"
                }
              }
            ],
            "output_names": [
              "Out"
            ],
            "locked": false,
            "pinned": false,
            "node_type_metadata": {
              "Layer": {
                "position": {
                  "Stack": 0
                }
              }
            },
            "network_metadata": {
              "persistent_metadata": {
                "reference": "Merge",
                "node_metadata": [
                  [
                    0,
                    {
                      "persistent_metadata": {
                        "display_name": "",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Value",
                              "input_description": ""
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                -21,
                                -2
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ],
                  [
                    1,
                    {
                      "persistent_metadata": {
                        "display_name": "",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Content",
                              "input_description": ""
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                -21,
                                -1
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ],
                  [
                    2,
                    {
                      "persistent_metadata": {
                        "display_name": "",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Node Path",
                              "input_description": ""
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                -21,
                                0
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ],
                  [
                    3,
                    {
                      "persistent_metadata": {
                        "display_name": "",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Content",
                              "input_description": "The list to set the named attribute on (one value per item).\n"
                            }
                          },
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Name",
                              "input_description": "The attribute name (key) to write or replace.\n"
                            }
                          },
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Value",
                              "input_description": "The node that produces the attribute value for each item. Called once per item with the item's index in context.\n"
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                -14,
                                -1
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ],
                  [
                    4,
                    {
                      "persistent_metadata": {
                        "display_name": "",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Content",
                              "input_description": ""
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                -7,
                                -1
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ],
                  [
                    5,
                    {
                      "persistent_metadata": {
                        "display_name": "",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Base",
                              "input_description": "The list whose items will appear at the start of the extended list.\n"
                            }
                          },
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "New",
                              "input_description": "The list whose items will appear at the end of the extended list.\n"
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                0,
                                -2
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ]
                ],
                "pinned_node_order": [],
                "previewing": "No",
                "navigation_metadata": {
                  "node_graph_ptz": {
                    "pan": [
                      0.0,
                      0.0
                    ],
                    "tilt": 0.0,
                    "zoom": 1.0,
                    "flip": false
                  },
                  "node_graph_to_viewport": [
                    1.0,
                    0.0,
                    0.0,
                    1.0,
                    0.0,
                    0.0
                  ],
                  "node_graph_width": 0.0
                }
              }
            }
          }
        }
      ],
      [
        12241147352993594415,
        {
          "persistent_metadata": {
            "display_name": "Artboard",
            "input_metadata": [
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": null,
                  "input_name": "Artboards",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "hidden",
                  "input_name": "Contents",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {
                    "is_integer": true,
                    "unit": " px",
                    "x": "X",
                    "y": "Y"
                  },
                  "widget_override": "vec2",
                  "input_name": "Location",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {
                    "is_integer": true,
                    "unit": " px",
                    "x": "W",
                    "y": "H"
                  },
                  "widget_override": "vec2",
                  "input_name": "Dimensions",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": "artboard_background",
                  "input_name": "Background",
                  "input_description": "TODO"
                }
              },
              {
                "persistent_metadata": {
                  "input_data": {},
                  "widget_override": null,
                  "input_name": "Clip",
                  "input_description": "TODO"
                }
              }
            ],
            "output_names": [
              "Out"
            ],
            "locked": false,
            "pinned": false,
            "node_type_metadata": {
              "Layer": {
                "position": {
                  "Absolute": [
                    -8,
                    3
                  ]
                }
              }
            },
            "network_metadata": {
              "persistent_metadata": {
                "reference": "Artboard",
                "node_metadata": [
                  [
                    0,
                    {
                      "persistent_metadata": {
                        "display_name": "",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Content",
                              "input_description": "Graphics to include within the artboard.\n"
                            }
                          },
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Location",
                              "input_description": "Coordinate of the top-left corner of the artboard within the document.\n"
                            }
                          },
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Dimensions",
                              "input_description": "Width and height of the artboard within the document.\n"
                            }
                          },
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Background",
                              "input_description": "Color of the artboard background.\n"
                            }
                          },
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Clip",
                              "input_description": "Whether to cut off the contained content that extends outside the artboard, or keep it visible.\n"
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                -21,
                                -3
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ],
                  [
                    1,
                    {
                      "persistent_metadata": {
                        "display_name": "",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Node Path",
                              "input_description": ""
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                -21,
                                3
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ],
                  [
                    2,
                    {
                      "persistent_metadata": {
                        "display_name": "",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Content",
                              "input_description": "The list to set the named attribute on (one value per item).\n"
                            }
                          },
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Name",
                              "input_description": "The attribute name (key) to write or replace.\n"
                            }
                          },
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Value",
                              "input_description": "The node that produces the attribute value for each item. Called once per item with the item's index in context.\n"
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                -14,
                                -3
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ],
                  [
                    3,
                    {
                      "persistent_metadata": {
                        "display_name": "",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Content",
                              "input_description": ""
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                -7,
                                -3
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ],
                  [
                    4,
                    {
                      "persistent_metadata": {
                        "display_name": "",
                        "input_metadata": [
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "Base",
                              "input_description": "The list whose items will appear at the start of the extended list.\n"
                            }
                          },
                          {
                            "persistent_metadata": {
                              "input_data": {},
                              "widget_override": null,
                              "input_name": "New",
                              "input_description": "The list whose items will appear at the end of the extended list.\n"
                            }
                          }
                        ],
                        "output_names": [],
                        "locked": false,
                        "pinned": false,
                        "node_type_metadata": {
                          "Node": {
                            "position": {
                              "Absolute": [
                                0,
                                -4
                              ]
                            }
                          }
                        },
                        "network_metadata": null
                      }
                    }
                  ]
                ],
                "pinned_node_order": [],
                "previewing": "No",
                "navigation_metadata": {
                  "node_graph_ptz": {
                    "pan": [
                      0.0,
                      0.0
                    ],
                    "tilt": 0.0,
                    "zoom": 1.0,
                    "flip": false
                  },
                  "node_graph_to_viewport": [
                    1.0,
                    0.0,
                    0.0,
                    1.0,
                    0.0,
                    0.0
                  ],
                  "node_graph_width": 0.0
                }
              }
            }
          }
        }
      ]
    ],
    "pinned_node_order": [],
    "previewing": "No",
    "navigation_metadata": {
      "node_graph_ptz": {
        "pan": [
          345.0,
          -187.0
        ],
        "tilt": 0.0,
        "zoom": 1.0,
        "flip": false
      },
      "node_graph_to_viewport": [
        1.0,
        0.0,
        0.0,
        1.0,
        1335.0,
        393.0
      ],
      "node_graph_width": 1980.0
    }
  }
};


/**
 * Assembles the full top-level document: network (nodes + single export at the
 * artboard wrapper) plus the verbatim editor-state scaffold and network
 * metadata. Key order matches the fixtures: `network_interface` first, then
 * the editor-state keys in fixture order.
 */
export function assembleDocument(
  nodes: Array<[number, DocNodeEntry]>,
  exportNodeId: number,
): GraphiteDocument {
  return {
    network_interface: {
      network: {
        exports: [{ Node: { node_id: exportNodeId, output_index: 0 } }],
        nodes,
      },
      network_metadata: structuredClone(NETWORK_METADATA),
    },
    ...structuredClone(DOCUMENT_SCAFFOLD_FIELDS),
  };
}

/**
 * The proven text placement transform (DAffine2, column order
 * [xx, xy, yx, yy, tx, ty]) copied verbatim from the director-verified
 * TextNode document `tmp/p4-direct-text-itemwrapped.graphite` (Fill node
 * input 6, `_has_transform: true`), which rendered text at ~48 px cap
 * height on a 1000x500 artboard with the real CLI. Used verbatim by the
 * text-on-background template; do not re-derive.
 */
export const PROVEN_TEXT_TRANSFORM: readonly number[] = [0.0, -92.53735521402166, 92.53735521402166, 0.0, 9.606221358397944, -69.72678572415595];

