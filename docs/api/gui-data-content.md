# GUI data/forms/content API (development)

Next-minor development APIs, not part of the published 0.2.4 distribution. Authoritative signatures are the declarations of `@haiyue/extensions/gui-forms`, `/gui-data` and `/gui-content`. No additions are aggregated into the root. [Guide and runnable example](../engine-guide/gui-data-content.md).

Common options inherit original GuiElement options and optionally borrow `root`/`focusManager`. `element`, `setStyle(style)` and idempotent `dispose()` belong to composite controllers. Root disposal tears down controllers registered with it. Content/image resources remain application-owned. State is explicitly set; `emit` defaults false where present.

| Forms | Main contract | Parts |
| --- | --- | --- |
| GuiForm | register(field) → unregister; getValues, validate, submit, reset | Uses borrowed FormItem elements |
| GuiFormItem | label, control, required/help; setFeedback(message or null) | label/control/feedback |
| GuiInputNumber | input: original GuiInput; value; setValue(value or null, emit), commit → boolean, increment(delta) | input/decrease/increase |
| GuiAutoComplete | input/list/feedback; search(query?) → Promise<boolean>, select(key), close | input/feedback/suggestions; original list row/content |

Form fields: key, item, read, write, optional subscribe and validate(value, signal) returning string/null or Promise. Validation returns readonly status valid/invalid/cancelled, errors and values. Up to 256 unique fields. Number range defaults ±1e12; positive step defaults 1; precision 0–12 inferred from step. Suggestions default to 1,000 maximum, configurable to 100,000; `suggestionHeight` defaults to 150 logical pixels and rows use the original window cap. Invalid/duplicate keys and invalid numeric input are visible errors, not silent coercion.

| Data | Main contract | Parts |
| --- | --- | --- |
| GuiTable<T> | list/headers/columns; setItems, setSort(key or null, asc/desc), setFilter(predicate or null), setSelection | header/heading; original list row/content |
| GuiPagination | page/pageSize/pageCount; setPage, setTotal, setPageSize; optional jump | previous/summary/next |
| GuiTreeSelect<T> | trigger/tree/popup/searchInput/feedback; selectedKeys, setSelectedKeys, toggle, setQuery, activate → Promise<boolean>, open | trigger; shared popup panel/content |
| GuiCascader | trigger/list/popup/feedback; path; navigate(key) → Promise<boolean>, back | trigger; shared popup panel/content |

Table has 1–32 keyed columns with explicit widths 24–4,096 logical pixels. A column defines title/text, optional compare, editable/onEdit. Stable sort ties retain input order. Default row height 34 and viewport height 240; existing collection maxima apply. Fixed header and viewport share the declared width. Pagination totals/pages/sizes are integers up to 1e9; empty data has page 1; page-size changes retain the first old item. TreeSelect single mode accepts at most one selected key; multiple mode returns readonly keys. `loadChildren(node, signal)` and `isLeaf(node)` are optional. Queries keep matching nodes and ancestors, while GUI rows remain bounded. Cascader keys are unique per level, up to 100,000 nodes per level and 64 selected levels; async errors appear in feedback.

| Content | Main contract | Parts |
| --- | --- | --- |
| GuiSteps | buttons/currentKey/setCurrent; 1–256 unique keyed steps; optional item content and onChange | item/content |
| GuiTimeline | list/setItems; optional custom original collection-row factory | Original list row/content |
| GuiDescriptions | readonly keyed fields, borrowed content or text; 1–12 columns, up to 1,000 items; rowHeight defaults 44 horizontal / 76 vertical | item/label/value |
| GuiRate | stars/value/setValue; 1–20 stars, optional half/clear/readOnly | star |
| GuiResult | status/title/description/icon and borrowed actions | icon/title/description/actions |
| GuiRibbon | text/color/start or end; borrowed content | content/ribbon |
| GuiImagePreview | dialog/image/viewport; index/scale, open/close/setIndex/setZoom/dispose | Original Dialog, viewport/image/toolbar/counter/previous/next/zoomIn/zoomOut |
| GuiCarousel | indicators/index/setIndex; 1–100 borrowed slides; autoplay 0 or 250–3,600,000 ms | stage/navigation/indicator/slideN |
| GuiDraggable | handle; data/preview/disposePreview/onEnd callbacks use original drag protocol | handle/content |
| GuiResizable | handle/size/setSize; dimensions clamped to explicit min/max; pointer cancel restores initial drag size | handle/content |

ImagePreview accepts 1–1,000 borrowed sources and zoom 1–8; switching images resets pan/zoom. It is an overlay controller with `dialog` rather than an inline `element`/`setStyle` facade; set styles through its exposed original elements. Carousel returns slides with original visibility on disposal. Draggable previews and business constraints remain application-owned. Resizable defaults min 80×60, max 4,096×4,096; pointer events and directional actions use the existing input domain. No new event samplers, document listeners, timers, rendering backends or GPU resource owners are created.
