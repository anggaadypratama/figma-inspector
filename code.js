/* Figma Inspector — main thread.
 *
 * 1. Dump every readable property of the current selection, recursively (parent -> children).
 * 2. Enrich the dump: names of referenced styles / variables / components, per-range text
 *    styles, sublayer text, plugin data. Refs are collected from the finished tree and
 *    bulk-resolved, so every style/variable is looked up once for the whole selection.
 * 3. Let the UI browse the document and set the selection (browse + select by node id).
 *
 * NODE_FIELDS is generated from @figma/plugin-typings — see README "Regenerate field list".
 * Node-valued properties (parent, children, mainComponent, stuckNodes, text, overrides'
 * targets, …) are excluded on purpose: they either recurse forever or serialize to {}.
 * The ones we want are read explicitly in readNodeShallow(): children, node.text sublayer,
 * mainComponent.id.
 */

const NODE_FIELDS = [
  'id', 'type', 'name',
  'isAsset', 'currentUrl', 'devStatus', 'visible', 'locked', 'componentPropertyReferences',
  'boundVariables', 'resolvedVariableModes', 'explicitVariableModes', 'animationStyles', 'animations', 'constraints',
  'x', 'y', 'width', 'height', 'minWidth', 'maxWidth',
  'minHeight', 'maxHeight', 'relativeTransform', 'absoluteTransform', 'absoluteBoundingBox', 'absoluteRenderBounds',
  'constrainProportions', 'rotation', 'layoutSizingHorizontal', 'layoutSizingVertical', 'layoutAlign', 'layoutGrow',
  'layoutPositioning', 'gridRowAnchorIndex', 'gridColumnAnchorIndex', 'gridRowSpan', 'gridColumnSpan', 'gridChildHorizontalAlign',
  'gridChildVerticalAlign', 'targetAspectRatio', 'isMask', 'maskType', 'effects', 'effectStyleId',
  'opacity', 'blendMode', 'expanded', 'backgrounds', 'backgroundStyleId', 'layoutMode',
  'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'horizontalPadding', 'verticalPadding',
  'primaryAxisSizingMode', 'counterAxisSizingMode', 'strokesIncludedInLayout', 'layoutWrap', 'primaryAxisAlignItems', 'counterAxisAlignItems',
  'counterAxisAlignContent', 'itemSpacing', 'counterAxisSpacing', 'itemReverseZIndex', 'gridRowCount', 'gridColumnCount',
  'gridRowGap', 'gridColumnGap', 'gridRowSizes', 'gridColumnSizes', 'gridAutoTracks', 'gridItemsPositioning',
  'strokes', 'strokeStyleId', 'strokeWeight', 'strokeJoin', 'strokeAlign', 'dashPattern',
  'strokeTopWeight', 'strokeBottomWeight', 'strokeLeftWeight', 'strokeRightWeight', 'fills', 'fillStyleId',
  'strokeCap', 'strokeMiterLimit', 'variableWidthStrokeProperties', 'complexStrokeProperties', 'cornerRadius', 'cornerSmoothing',
  'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'exportSettings', 'overflowDirection',
  'numberOfFixedChildren', 'overlayPositionType', 'overlayBackground', 'overlayBackgroundInteraction', 'vectorNetwork', 'handleMirroring',
  'reactions', 'description', 'documentationLinks', 'remote', 'key',
  'detachedInfo', 'layoutGrids', 'gridStyleId', 'clipsContent', 'guides', 'inferredAutoLayout',
  'annotations', 'componentPropertyDefinitions', 'hasMissingFont', 'fontSize',
  'fontName', 'fontWeight', 'textCase', 'openTypeFeatures', 'letterSpacing', 'hyperlink',
  'characters', 'paragraphIndent', 'paragraphSpacing', 'textWrapStyle', 'listSpacing',
  'hangingPunctuation', 'hangingList', 'textDecoration', 'textDecorationStyle', 'textDecorationOffset', 'textDecorationThickness',
  'textDecorationColor', 'textDecorationSkipInk', 'lineHeight', 'leadingTrim', 'transformModifiers', 'arcData',
  'pointCount', 'innerRadius', 'textAlignHorizontal', 'textAlignVertical', 'textAutoResize', 'textTruncation',
  'maxLines', 'autoRename', 'textStyleId', 'textPathStartData', 'componentProperties', 'scaleFactor',
  'isExposedInstance', 'overrides', 'limitViolations', 'booleanOperation', 'numRows', 'numColumns',
  'rowIndex', 'columnIndex', 'shapeType', 'code', 'codeLanguage', 'textBackground',
  'connectorLineType', 'connectorStart', 'connectorEnd', 'connectorStartStrokeCap', 'connectorEndStrokeCap', 'widgetId',
  'widgetSyncedState', 'syncedStateOverrides', 'syncedMapOverrides', 'syncedState', 'embedData', 'linkUnfurlData',
  'mediaData', 'sectionContentsHidden', 'isSkippedSlide', 'interactiveSlideElementType'
];

/* node.text sublayer (SHAPE_WITH_TEXT, TABLE_CELL, TEXT_PATH) */
const TEXT_LAYER_FIELDS = [
  'characters', 'fontName', 'fontSize', 'fontWeight', 'fontStyle', 'textCase', 'textDecoration',
  'letterSpacing', 'lineHeight', 'leadingTrim', 'textAlignHorizontal', 'textAlignVertical',
  'textAutoResize', 'textWrapStyle', 'listSpacing', 'paragraphIndent', 'paragraphSpacing',
  'fills', 'fillStyleId', 'textStyleId', 'hyperlink'
];

/* StyledTextSegment fields; 'characters' comes per segment, 'start'/'end' are the range. */
const SEGMENT_FIELDS = [
  'fontSize', 'fontName', 'fontWeight', 'fontStyle', 'textDecoration', 'textDecorationStyle',
  'textDecorationOffset', 'textDecorationThickness', 'textDecorationColor', 'textDecorationSkipInk',
  'textCase', 'lineHeight', 'letterSpacing', 'fills', 'fillStyleId', 'textStyleId', 'listOptions',
  'listSpacing', 'indentation', 'paragraphIndent', 'paragraphSpacing', 'textWrapStyle', 'hyperlink',
  'openTypeFeatures', 'boundVariables', 'textStyleOverrides'
];

const STYLE_KEYS = [
  'fillStyleId', 'strokeStyleId', 'effectStyleId', 'textStyleId', 'gridStyleId', 'backgroundStyleId'
];

/* The property surface of a node is fixed by its type, so probe NODE_FIELDS once per type
 * and reuse the result — otherwise every node pays ~180 host proxy reads.
 * ponytail: assumption is per-type stability, true for the plugin API. If a field ever goes
 * missing, drop the cache and probe per node. */
const fieldsByType = {};

function fieldsFor(node) {
  let hit = fieldsByType[node.type];
  if (!hit) {
    hit = [];
    for (const name of NODE_FIELDS) {
      try { if (name in node) hit.push(name); } catch (e) { /* not supported on this type */ }
    }
    fieldsByType[node.type] = hit;
  }
  return hit;
}

function getField(node, name) {
  try {
    const v = node[name];
    if (v === undefined || typeof v === 'function') return undefined;
    return typeof v === 'symbol' ? 'figma.mixed' : v;
  } catch (e) {
    return undefined;
  }
}

function readFields(node, names) {
  const out = {};
  for (const name of names) {
    const v = getField(node, name);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/* absoluteBoundingBox is null for nodes outside a loaded page; derive it from the transform. */
function absBBox(node) {
  try {
    const m = node.absoluteTransform;
    const w = node.width, h = node.height;
    const xs = [m[0][2], m[0][0] * w + m[0][1] * h + m[0][2]];
    const ys = [m[1][2], m[1][0] * w + m[1][1] * h + m[1][2]];
    return {
      x: Math.min.apply(null, xs),
      y: Math.min.apply(null, ys),
      width: Math.abs(xs[0] - xs[1]),
      height: Math.abs(ys[0] - ys[1])
    };
  } catch (e) {
    return undefined;
  }
}

function readSegments(node) {
  try {
    return node.getStyledTextSegments(SEGMENT_FIELDS).map(function (seg) {
      const out = {};
      for (const key in seg) {
        const v = seg[key];
        out[key] = typeof v === 'symbol' ? 'figma.mixed' : v;
      }
      return out;
    });
  } catch (e) {
    return null;
  }
}

function sublayerOf(node) {
  if (node.type !== 'SHAPE_WITH_TEXT' && node.type !== 'TABLE_CELL' && node.type !== 'TEXT_PATH') return null;
  try {
    return node.text || null;
  } catch (e) {
    return null;
  }
}

function readPluginData(node) {
  try {
    const keys = node.getPluginDataKeys();
    if (!keys.length) return null;
    const out = {};
    for (const k of keys) out[k] = node.getPluginData(k);
    return out;
  } catch (e) {
    return null;
  }
}

/* Own properties only — children are queued by readTree() so the walk can yield. */
function readNodeShallow(node) {
  const out = readFields(node, fieldsFor(node));

  if (node.type === 'TEXT') {
    const segs = readSegments(node);
    if (segs && segs.length) out.textSegments = segs;
  }

  const sub = sublayerOf(node);
  if (sub) out.textLayer = readFields(sub, TEXT_LAYER_FIELDS);

  if (node.type === 'INSTANCE') {
    try { if (node.mainComponent) out.mainComponentId = node.mainComponent.id; } catch (e) { /* detached */ }
  }

  const pd = readPluginData(node);
  if (pd) out.pluginData = pd;

  if (out.absoluteBoundingBox == null) {
    const b = absBBox(node);
    if (b) out.absoluteBoundingBox = b;
  }

  return out;
}

/* Every property read is a synchronous round-trip to the Figma host, so a page-sized selection
 * is 10^4–10^5 blocking reads inside a single JS turn: Figma stops responding and the dump
 * never arrives. Two guards keep that bounded: the walk yields to the host every CHUNK nodes
 * (canvas keeps breathing, dump still finishes), and MAX_NODES caps the payload so the UI can
 * still render it. Raise MAX_NODES in code.js if you need a deeper dump. */
const MAX_NODES = 2000;
const CHUNK = 50;

function yieldToHost() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

async function readTree(roots) {
  const selection = [];
  const frames = [];   // parents whose children list is being read, resumable mid-list
  let seen = 0;
  let truncated = false;

  /* One node: read it, and open a frame if it has children to walk. */
  function start(node, out) {
    if (seen >= MAX_NODES) { truncated = true; return false; }
    seen++;
    if ('children' in node) {
      out.children = [];
      frames.push({ node: node, out: out, index: 0 });
    }
    return true;
  }

  for (const root of roots) {
    const out = readNodeShallow(root);
    if (!start(root, out)) break;
    selection.push(out);
  }

  /* Budget is counted in nodes, not parents: one parent with 10k children would otherwise be a
   * single unbroken turn. A frame stays on the stack and resumes where it stopped. */
  while (frames.length && !truncated) {
    let budget = CHUNK;
    while (budget > 0 && frames.length && !truncated) {
      const frame = frames[0];
      const children = frame.node.children;
      while (budget > 0 && frame.index < children.length) {
        const child = children[frame.index++];
        budget--;
        const out = readNodeShallow(child);
        if (!start(child, out)) {
          frame.out.childrenTruncated = true;
          break;
        }
        frame.out.children.push(out);
      }
      if (frame.index >= children.length) frames.shift();
    }
    await yieldToHost();
  }

  return { selection: selection, nodeCount: seen, truncated: truncated };
}

/* ---------- reference collection + bulk resolution ---------- */

function collectAliases(value, into) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) collectAliases(item, into);
    return;
  }
  if (value.type === 'VARIABLE_ALIAS' && typeof value.id === 'string') into.add(value.id);
  for (const k in value) collectAliases(value[k], into);
}

function collectRefs(nodes) {
  const refs = { styles: new Set(), variables: new Set(), components: new Set(), collections: new Set() };
  const addStyle = (v) => { if (typeof v === 'string' && v) refs.styles.add(v); };

  function visit(n) {
    for (const k of STYLE_KEYS) addStyle(n[k]);
    if (n.boundVariables) collectAliases(n.boundVariables, refs.variables);
    for (const k in n.explicitVariableModes || {}) refs.collections.add(k);

    if (n.textLayer) {
      for (const k of STYLE_KEYS) addStyle(n.textLayer[k]);
    }
    for (const seg of n.textSegments || []) {
      for (const k of STYLE_KEYS) addStyle(seg[k]);
      if (seg.boundVariables) collectAliases(seg.boundVariables, refs.variables);
    }
    for (const p of Object.values(n.componentProperties || {})) {
      if (p && p.boundVariables) collectAliases(p.boundVariables, refs.variables);
    }
    if (typeof n.mainComponentId === 'string' && n.mainComponentId) refs.components.add(n.mainComponentId);

    for (const c of n.children || []) visit(c);
  }

  for (const n of nodes) visit(n);
  return refs;
}

/* Lookups hit the host process; keep concurrency bounded. */
async function mapLimit(items, limit, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push.apply(out, await Promise.all(items.slice(i, i + limit).map(fn)));
  }
  return out;
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) {
    try {
      const v = obj[k];
      if (v !== undefined) out[k] = typeof v === 'symbol' ? 'figma.mixed' : v;
    } catch (e) { /* skip */ }
  }
  return out;
}

async function resolveRefs(refs) {
  const counts = { styles: refs.styles.size, variables: refs.variables.size, components: refs.components.size };
  if (!counts.styles && !counts.variables && !counts.components) return { counts: counts };

  const [styles, variables, components] = await Promise.all([
    mapLimit([...refs.styles], 40, (id) => figma.getStyleByIdAsync(id).catch(() => null)),
    mapLimit([...refs.variables], 40, (id) => figma.variables.getVariableByIdAsync(id).catch(() => null)),
    mapLimit([...refs.components], 40, (id) => figma.getNodeByIdAsync(id).catch(() => null))
  ]);

  const maps = { counts: counts };

  if (styles.filter(Boolean).length) {
    maps.styles = {};
    for (const s of styles) {
      if (s) maps.styles[s.id] = pick(s, ['name', 'styleType', 'key', 'remote', 'description']);
    }
  }

  if (variables.filter(Boolean).length) {
    maps.variables = {};
    for (const v of variables) {
      if (!v) continue;
      maps.variables[v.id] = pick(v, [
        'name', 'resolvedType', 'variableCollectionId', 'valuesByMode', 'codeSyntax',
        'description', 'remote', 'key', 'scopes', 'hiddenFromPublishing'
      ]);
      if (v.variableCollectionId) refs.collections.add(v.variableCollectionId);
    }
    const collections = (await mapLimit([...refs.collections], 20, (id) =>
      figma.variables.getVariableCollectionByIdAsync(id).catch(() => null))).filter(Boolean);
    if (collections.length) {
      maps.variableCollections = {};
      for (const c of collections) {
        maps.variableCollections[c.id] = pick(c, ['name', 'modes', 'defaultModeId', 'remote', 'key', 'hiddenFromPublishing']);
      }
    }
  }

  if (components.filter(Boolean).length) {
    maps.components = {};
    for (const c of components) {
      if (c) maps.components[c.id] = pick(c, ['name', 'key', 'description', 'componentSetId', 'remote']);
    }
  }

  return maps;
}

/* ---------- snapshot ---------- */

async function snapshot() {
  const selection = figma.currentPage.selection;
  const tree = await readTree(selection);

  const refs = collectRefs(tree.selection);
  const resolved = await resolveRefs(refs);

  const data = {
    exportedAt: new Date().toISOString(),
    file: { key: figma.fileKey || null, name: figma.root.name },
    page: { id: figma.currentPage.id, name: figma.currentPage.name },
    selectionCount: selection.length,
    totalNodeCount: tree.nodeCount,
    maxNodes: MAX_NODES,
    truncated: tree.truncated,
    referenceCounts: resolved.counts,
    selection: tree.selection
  };
  if (resolved.styles) data.styles = resolved.styles;
  if (resolved.variables) data.variables = resolved.variables;
  if (resolved.variableCollections) data.variableCollections = resolved.variableCollections;
  if (resolved.components) data.components = resolved.components;
  return data;
}

let busy = false;
let queued = false;
let scheduled = null;

/* Figma fires selectionchange on every intermediate state while a selection is dragged; a short
 * delay collapses that burst into one dump. Manual refresh / select uses delay 0. */
function scheduleSnapshot(delay) {
  clearTimeout(scheduled);
  scheduled = setTimeout(function () {
    scheduled = null;
    pushSnapshot();
  }, delay);
}

async function pushSnapshot() {
  if (busy) { queued = true; return; }
  busy = true;
  try {
    figma.ui.postMessage({ type: 'result', data: await snapshot() });
  } catch (e) {
    figma.ui.postMessage({ type: 'error', message: String((e && e.message) || e) });
  } finally {
    busy = false;
    if (queued) { queued = false; pushSnapshot(); }
  }
}

/* ---------- browse / select ---------- */

function nodeInfo(node) {
  let childCount = 0;
  try { if ('children' in node) childCount = node.children.length; } catch (e) { /* none */ }
  return {
    id: node.id,
    name: node.name,
    type: node.type,
    childCount: childCount,
    visible: getField(node, 'visible') !== false
  };
}

function pageOf(node) {
  let n = node;
  while (n && n.type !== 'PAGE') {
    try { n = n.parent; } catch (e) { return null; }
  }
  return n || null;
}

async function selectById(id) {
  const node = await figma.getNodeByIdAsync(id);
  if (!node) return figma.ui.postMessage({ type: 'select-result', ok: false, message: 'Node not found: ' + id });

  try {
    const page = pageOf(node);
    if (page && figma.currentPage !== page) figma.currentPage = page;
    if (node.type !== 'PAGE') {
      figma.currentPage.selection = [node];
      figma.viewport.scrollAndZoomIntoView([node]);
    }
  } catch (e) {
    return figma.ui.postMessage({ type: 'select-result', ok: false, message: String((e && e.message) || e) });
  }
  figma.ui.postMessage({ type: 'select-result', ok: true, id: node.id, name: node.name, nodeType: node.type });
  scheduleSnapshot(0);
}

async function listChildren(id) {
  const parent = id ? await figma.getNodeByIdAsync(id) : figma.currentPage;
  let items = [];
  try { if (parent && 'children' in parent) items = parent.children.map(nodeInfo); } catch (e) { /* none */ }
  figma.ui.postMessage({ type: 'children', parentId: id || null, items: items });
}

/* ---------- wiring ---------- */

/* Invisible children of instances are skipped by default; a full dump wants them. */
try { figma.skipInvisibleInstanceChildren = false; } catch (e) { /* older API */ }

figma.showUI(__html__, { width: 560, height: 720, title: 'Figma Inspector' });

figma.ui.onmessage = function (msg) {
  if (!msg) return;
  if (msg.type === 'refresh') return void scheduleSnapshot(0);
  if (msg.type === 'pages') {
    return void figma.ui.postMessage({
      type: 'pages',
      currentPageId: figma.currentPage.id,
      items: figma.root.children.map(nodeInfo)
    });
  }
  if (msg.type === 'children') return void listChildren(msg.id);
  if (msg.type === 'select') return void selectById(msg.id);
};

figma.on('selectionchange', function () { scheduleSnapshot(250); });
