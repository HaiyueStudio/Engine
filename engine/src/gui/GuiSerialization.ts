import type { GuiElementOptions, GuiLength, GuiStyle, GuiTheme } from './GuiTypes';
import { requiredItemAt } from '../math/arrayAccess';
import { EngineError, EngineErrorCode, ErrorDomain } from '../core/EngineError';

export const GUI_SERIALIZATION_FORMAT = 'haiyue.gui' as const;
export const GUI_SERIALIZATION_VERSION = 1 as const;
import {
  GuiButton,
  GuiCheckbox,
  GuiElement,
  GuiImage,
  type GuiImageSource,
  GuiInput,
  GuiLabel,
  type GuiLabelTextAlign,
  GuiProgress,
  GuiRadio,
  GuiRoot,
  GuiSelect,
  type GuiSelectOption,
  GuiSlider,
  GuiSwitch,
  GuiTooltip,
  type GuiTooltipPlacement,
  GuiTree,
  type GuiTreeNode,
} from './components';

export type GuiSerializedValue = string | number | boolean | null;

export type GuiSerializedElementType =
  | 'element'
  | 'button'
  | 'label'
  | 'input'
  | 'checkbox'
  | 'switch'
  | 'radio'
  | 'slider'
  | 'progress'
  | 'select'
  | 'tree'
  | 'tooltip'
  | 'image';

export interface GuiSerializedElement {
  type: GuiSerializedElementType;
  id?: string | undefined;
  x?: GuiLength | undefined;
  y?: GuiLength | undefined;
  width?: GuiLength | undefined;
  height?: GuiLength | undefined;
  visible?: boolean | undefined;
  disabled?: boolean | undefined;
  style?: GuiStyle | undefined;
  children?: GuiSerializedElement[];
  props?: Record<string, unknown>;
}

export interface GuiSerializedRoot {
  format: typeof GUI_SERIALIZATION_FORMAT;
  version: typeof GUI_SERIALIZATION_VERSION;
  type: 'root';
  theme?: Partial<GuiTheme>;
  root: GuiSerializedElement;
}

export interface GuiDeserializeOptions {
  resolveImageSource?: (sourceKey: string) => GuiImageSource;
  resolveTooltipTarget?: (targetId: string) => GuiElement | null;
}

export function serializeGuiRoot(root: GuiRoot): GuiSerializedRoot {
  return {
    format: GUI_SERIALIZATION_FORMAT,
    version: GUI_SERIALIZATION_VERSION,
    type: 'root',
    theme: cloneTheme(root.theme),
    root: serializeGuiElement(root.root),
  };
}

export function deserializeGuiRoot(data: unknown, options: GuiDeserializeOptions = {}): GuiRoot {
  const serialized = validateGuiSerializedRoot(data);
  const rootElement = deserializeGuiElementInternal(serialized.root, options);
  const layout = rootElement.getLayoutOptions();
  const root = new GuiRoot({
    id: rootElement.id,
    x: layout.x,
    y: layout.y,
    width: layout.width,
    height: layout.height,
    visible: rootElement.visible,
    disabled: rootElement.disabled,
    style: cloneStyle(rootElement.style),
    theme: serialized.theme,
  });
  root.root.children.length = 0;
  for (const child of rootElement.children) root.add(child);
  return root;
}

export function serializeGuiElement(element: GuiElement): GuiSerializedElement {
  const layout = element.getLayoutOptions();
  const serialized: GuiSerializedElement = {
    type: getSerializedElementType(element),
    id: element.id,
    x: layout.x,
    y: layout.y,
    width: layout.width,
    height: layout.height,
    visible: element.visible,
    disabled: element.disabled,
    style: cloneStyle(element.style),
  };
  const props = serializeElementProps(element);
  if (Object.keys(props).length > 0) serialized.props = props;
  if (element.children.length > 0) serialized.children = element.children.map(serializeGuiElement);
  return serialized;
}

export function deserializeGuiElement(data: unknown, options: GuiDeserializeOptions = {}): GuiElement {
  const serialized = validateGuiSerializedElement(data, '$');
  return deserializeGuiElementInternal(serialized, options);
}

function deserializeGuiElementInternal(data: GuiSerializedElement, options: GuiDeserializeOptions): GuiElement {
  const element = createGuiElement(data, options);
  for (const childData of data.children ?? []) element.add(deserializeGuiElementInternal(childData, options));
  element.clearDirty();
  return element;
}

export function validateGuiSerializedRoot(data: unknown): GuiSerializedRoot {
  const root = recordAt(data, '$');
  if (root.format !== GUI_SERIALIZATION_FORMAT) {
    invalidGuiData('Unsupported GUI serialization format.', '$.format', {
      expectedFormat: GUI_SERIALIZATION_FORMAT,
      receivedFormat: root.format,
    });
  }
  if (!Number.isInteger(root.version)) {
    invalidGuiData('GUI serialization version must be an integer.', '$.version', {
      format: GUI_SERIALIZATION_FORMAT,
      receivedVersion: root.version,
    });
  }
  if (root.version !== GUI_SERIALIZATION_VERSION) {
    invalidGuiData('Unsupported GUI serialization version.', '$.version', {
      format: GUI_SERIALIZATION_FORMAT,
      expectedVersion: GUI_SERIALIZATION_VERSION,
      receivedVersion: root.version,
    });
  }
  if (root.type !== 'root') invalidGuiData('GUI root type must be "root".', '$.type');
  if (root.theme !== undefined) validateTheme(root.theme, '$.theme');
  return {
    format: GUI_SERIALIZATION_FORMAT,
    version: GUI_SERIALIZATION_VERSION,
    type: 'root',
    ...(root.theme === undefined ? {} : { theme: root.theme as Partial<GuiTheme> }),
    root: validateGuiSerializedElement(root.root, '$.root'),
  };
}

export function validateGuiSerializedElement(data: unknown, path = '$'): GuiSerializedElement {
  const element = recordAt(data, path);
  if (!GUI_ELEMENT_TYPES.has(element.type as GuiSerializedElementType)) {
    invalidGuiData('Unknown GUI element type.', `${path}.type`, { receivedType: element.type });
  }
  optional(element.id, 'string', `${path}.id`);
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    if (element[key] !== undefined && !isGuiLength(element[key])) {
      invalidGuiData('GUI layout values must be finite numbers or percentage strings.', `${path}.${key}`);
    }
  }
  optional(element.visible, 'boolean', `${path}.visible`);
  optional(element.disabled, 'boolean', `${path}.disabled`);
  if (element.style !== undefined) validateStyle(element.style, `${path}.style`);
  if (element.props !== undefined) validateProps(element.type as GuiSerializedElementType, element.props, `${path}.props`);
  let children: GuiSerializedElement[] | undefined;
  if (element.children !== undefined) {
    if (!Array.isArray(element.children)) invalidGuiData('GUI children must be an array.', `${path}.children`);
    children = element.children.map((child, index) => validateGuiSerializedElement(child, `${path}.children[${index}]`));
  }
  return {
    type: element.type as GuiSerializedElementType,
    ...(element.id === undefined ? {} : { id: element.id as string }),
    ...(element.x === undefined ? {} : { x: element.x as GuiLength }),
    ...(element.y === undefined ? {} : { y: element.y as GuiLength }),
    ...(element.width === undefined ? {} : { width: element.width as GuiLength }),
    ...(element.height === undefined ? {} : { height: element.height as GuiLength }),
    ...(element.visible === undefined ? {} : { visible: element.visible as boolean }),
    ...(element.disabled === undefined ? {} : { disabled: element.disabled as boolean }),
    ...(element.style === undefined ? {} : { style: element.style as GuiStyle }),
    ...(children === undefined ? {} : { children }),
    ...(element.props === undefined ? {} : { props: element.props as Record<string, unknown> }),
  };
}

function createGuiElement(data: GuiSerializedElement, options: GuiDeserializeOptions): GuiElement {
  const base = getBaseOptions(data);
  const props = data.props ?? {};
  switch (data.type) {
    case 'button':
      return new GuiButton({ ...base, text: stringProp(props.text, 'Button'), variant: variantProp(props.variant) });
    case 'label': {
      const fontSize = optionalNumberProp(props.fontSize);
      return new GuiLabel({
        ...base,
        text: stringProp(props.text, ''),
        ...(fontSize === undefined ? {} : { fontSize }),
        textAlign: textAlignProp(props.textAlign),
        autoWidth: booleanProp(props.autoWidth, false),
      });
    }
    case 'input':
      return new GuiInput({
        ...base,
        value: stringProp(props.value, ''),
        placeholder: stringProp(props.placeholder, ''),
        readOnly: booleanProp(props.readOnly, false),
      });
    case 'checkbox':
      return new GuiCheckbox({ ...base, checked: booleanProp(props.checked, false), label: stringProp(props.label, '') });
    case 'switch':
      return new GuiSwitch({ ...base, checked: booleanProp(props.checked, false), label: stringProp(props.label, '') });
    case 'radio':
      return new GuiRadio({
        ...base,
        checked: booleanProp(props.checked, false),
        label: stringProp(props.label, ''),
        group: stringProp(props.group, 'default'),
        value: scalarProp(props.value, stringProp(props.label, '')),
      });
    case 'slider':
      return new GuiSlider({
        ...base,
        value: numberProp(props.value, 0),
        min: numberProp(props.min, 0),
        max: numberProp(props.max, 100),
        step: numberProp(props.step, 1),
      });
    case 'progress':
      return new GuiProgress({
        ...base,
        value: numberProp(props.value, 0),
        min: numberProp(props.min, 0),
        max: numberProp(props.max, 100),
        showText: booleanProp(props.showText, false),
      });
    case 'select':
      return new GuiSelect({
        ...base,
        value: scalarProp(props.value, null),
        options: selectOptionsProp(props.options),
        placeholder: stringProp(props.placeholder, 'Select'),
        optionHeight: numberProp(props.optionHeight, 28),
        maxVisibleOptions: numberProp(props.maxVisibleOptions, 6),
      });
    case 'tree':
      return new GuiTree({
        ...base,
        nodes: treeNodesProp(props.nodes),
        expandedKeys: stringArrayProp(props.expandedKeys),
        selectedKey: nullableStringProp(props.selectedKey),
        rowHeight: numberProp(props.rowHeight, 28),
        indent: numberProp(props.indent, 18),
      });
    case 'tooltip': {
      const targetId = stringProp(props.targetId, '');
      const target = targetId ? options.resolveTooltipTarget?.(targetId) : null;
      return new GuiTooltip({
        ...base,
        target: target ?? new GuiElement({ id: targetId || `${data.id ?? 'tooltip'}-target` }),
        content: stringProp(props.content, ''),
        placement: placementProp(props.placement),
        delay: numberProp(props.delay, 0),
      });
    }
    case 'image': {
      const sourceKey = nullableStringProp(props.sourceKey);
      return new GuiImage({
        ...base,
        sourceKey: sourceKey ?? undefined,
        source: sourceKey ? options.resolveImageSource?.(sourceKey) ?? null : null,
        uv: uvProp(props.uv),
        tint: stringProp(props.tint, '#ffffff'),
      });
    }
    default:
      return new GuiElement(base);
  }
}

function getSerializedElementType(element: GuiElement): GuiSerializedElementType {
  if (element instanceof GuiButton) return 'button';
  if (element instanceof GuiLabel) return 'label';
  if (element instanceof GuiInput) return 'input';
  if (element instanceof GuiSwitch) return 'switch';
  if (element instanceof GuiCheckbox) return 'checkbox';
  if (element instanceof GuiRadio) return 'radio';
  if (element instanceof GuiSlider) return 'slider';
  if (element instanceof GuiProgress) return 'progress';
  if (element instanceof GuiSelect) return 'select';
  if (element instanceof GuiTree) return 'tree';
  if (element instanceof GuiTooltip) return 'tooltip';
  if (element instanceof GuiImage) return 'image';
  return 'element';
}

function serializeElementProps(element: GuiElement): Record<string, unknown> {
  if (element instanceof GuiButton) return { text: element.text, variant: element.variant };
  if (element instanceof GuiLabel) {
    return {
      text: element.text,
      ...(element.fontSize === undefined ? {} : { fontSize: element.fontSize }),
      textAlign: element.textAlign,
      autoWidth: element.autoWidth,
    };
  }
  if (element instanceof GuiInput) return { value: element.value, placeholder: element.placeholder, readOnly: element.readOnly };
  if (element instanceof GuiSwitch) return { checked: element.checked, label: element.label };
  if (element instanceof GuiCheckbox) return { checked: element.checked, label: element.label };
  if (element instanceof GuiRadio) return { checked: element.checked, label: element.label, group: element.group, value: scalarProp(element.value, null) };
  if (element instanceof GuiSlider) return { value: element.value, min: element.min, max: element.max, step: element.step };
  if (element instanceof GuiProgress) return { value: element.value, min: element.min, max: element.max, showText: element.showText };
  if (element instanceof GuiSelect) {
    return {
      value: scalarProp(element.value, null),
      options: element.options.map(option => ({ ...option, value: scalarProp(option.value, null) })),
      placeholder: element.placeholder,
      optionHeight: element.optionHeight,
      maxVisibleOptions: element.maxVisibleOptions,
    };
  }
  if (element instanceof GuiTree) {
    return {
      nodes: element.nodes,
      expandedKeys: Array.from(element.expandedKeys),
      selectedKey: element.selectedKey,
      rowHeight: element.rowHeight,
      indent: element.indent,
    };
  }
  if (element instanceof GuiTooltip) {
    return {
      targetId: element.target.id,
      content: element.content,
      placement: element.placement,
      delay: element.delay,
    };
  }
  if (element instanceof GuiImage) return { sourceKey: element.sourceKey ?? null, uv: [...element.uv], tint: element.tint };
  return {};
}

function getBaseOptions(data: GuiSerializedElement): GuiElementOptions {
  return {
    id: data.id,
    x: data.x,
    y: data.y,
    width: data.width,
    height: data.height,
    visible: data.visible,
    disabled: data.disabled,
    style: cloneStyle(data.style),
  };
}

function cloneStyle(style: GuiStyle | undefined): GuiStyle | undefined {
  return style ? { ...style } : undefined;
}

function cloneTheme(theme: GuiTheme): Partial<GuiTheme> {
  return {
    fontFamily: theme.fontFamily,
    fontSize: theme.fontSize,
    radius: theme.radius,
    colors: { ...theme.colors },
  };
}

function stringProp(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableStringProp(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function numberProp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalNumberProp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanProp(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function scalarProp(value: unknown, fallback: GuiSerializedValue): GuiSerializedValue {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value;
  if (value === null) return null;
  return fallback;
}

function variantProp(value: unknown): 'default' | 'primary' | 'danger' {
  return value === 'primary' || value === 'danger' ? value : 'default';
}

function textAlignProp(value: unknown): GuiLabelTextAlign {
  return value === 'center' || value === 'right' ? value : 'left';
}

function placementProp(value: unknown): GuiTooltipPlacement {
  return value === 'right' || value === 'bottom' || value === 'left' ? value : 'top';
}

function stringArrayProp(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function uvProp(value: unknown): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) return [0, 0, 1, 1];
  return [
    numberProp(requiredItemAt(value, 0, 'serialized GUI uv'), 0),
    numberProp(requiredItemAt(value, 1, 'serialized GUI uv'), 0),
    numberProp(requiredItemAt(value, 2, 'serialized GUI uv'), 0),
    numberProp(requiredItemAt(value, 3, 'serialized GUI uv'), 0),
  ];
}

function selectOptionsProp(value: unknown): GuiSelectOption<GuiSerializedValue>[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map(item => ({
      label: stringProp(item.label, ''),
      value: scalarProp(item.value, null),
      disabled: booleanProp(item.disabled, false),
    }));
}

function treeNodesProp(value: unknown): GuiTreeNode<GuiSerializedValue>[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map(item => ({
      key: stringProp(item.key, ''),
      label: stringProp(item.label, ''),
      value: scalarProp(item.value, null),
      disabled: booleanProp(item.disabled, false),
      children: treeNodesProp(item.children),
    }));
}

const GUI_ELEMENT_TYPES = new Set<GuiSerializedElementType>([
  'element', 'button', 'label', 'input', 'checkbox', 'switch', 'radio', 'slider',
  'progress', 'select', 'tree', 'tooltip', 'image',
]);

const STRING_PROPS = new Set(['text', 'variant', 'textAlign', 'placeholder', 'label', 'group', 'content', 'placement', 'sourceKey', 'tint', 'targetId']);
const NUMBER_PROPS = new Set(['fontSize', 'min', 'max', 'step', 'optionHeight', 'maxVisibleOptions', 'rowHeight', 'indent', 'delay']);
const BOOLEAN_PROPS = new Set(['autoWidth', 'readOnly', 'checked', 'showText']);

function validateProps(type: GuiSerializedElementType, value: unknown, path: string): void {
  const props = recordAt(value, path);
  for (const [key, prop] of Object.entries(props)) {
    const propPath = `${path}.${key}`;
    if (STRING_PROPS.has(key)) {
      if (key === 'sourceKey' && prop === null) continue;
      else if (typeof prop !== 'string') invalidGuiData(`GUI ${key} must be a string.`, propPath);
      if (key === 'variant' && prop !== 'default' && prop !== 'primary' && prop !== 'danger') {
        invalidGuiData('GUI button variant is invalid.', propPath, { receivedVariant: prop });
      }
      if (key === 'textAlign' && prop !== 'left' && prop !== 'center' && prop !== 'right') {
        invalidGuiData('GUI label text alignment is invalid.', propPath, { receivedTextAlign: prop });
      }
      if (key === 'placement' && prop !== 'top' && prop !== 'right' && prop !== 'bottom' && prop !== 'left') {
        invalidGuiData('GUI tooltip placement is invalid.', propPath, { receivedPlacement: prop });
      }
      continue;
    }
    if (NUMBER_PROPS.has(key) || key === 'value') {
      if (key === 'value' && (type === 'radio' || type === 'select')) validateScalar(prop, propPath);
      else if (key === 'value' && type === 'input') {
        if (typeof prop !== 'string') invalidGuiData('GUI input value must be a string.', propPath);
      }
      else if (typeof prop !== 'number' || !Number.isFinite(prop)) invalidGuiData(`GUI ${key} must be a finite number.`, propPath);
      continue;
    }
    if (BOOLEAN_PROPS.has(key)) {
      if (typeof prop !== 'boolean') invalidGuiData(`GUI ${key} must be a boolean.`, propPath);
      continue;
    }
    if (key === 'uv') {
      if (!Array.isArray(prop) || prop.length !== 4) invalidGuiData('GUI image uv must contain four finite numbers.', propPath);
      prop.forEach((item, index) => {
        if (typeof item !== 'number' || !Number.isFinite(item)) invalidGuiData('GUI image uv must contain four finite numbers.', `${propPath}[${index}]`);
      });
      continue;
    }
    if (key === 'expandedKeys') {
      validateStringArray(prop, propPath);
      continue;
    }
    if (key === 'selectedKey') {
      if (prop !== null && typeof prop !== 'string') invalidGuiData('GUI selectedKey must be a string or null.', propPath);
      continue;
    }
    if (key === 'options') {
      if (!Array.isArray(prop)) invalidGuiData('GUI select options must be an array.', propPath);
      prop.forEach((item, index) => validateSelectOption(item, `${propPath}[${index}]`));
      continue;
    }
    if (key === 'nodes') {
      validateTreeNodes(prop, propPath);
      continue;
    }
    invalidGuiData('Unknown GUI serialized property.', propPath, { elementType: type, property: key });
  }
}

function validateSelectOption(value: unknown, path: string): void {
  const option = recordAt(value, path);
  if (typeof option.label !== 'string') invalidGuiData('GUI select option label must be a string.', `${path}.label`);
  validateScalar(option.value, `${path}.value`);
  optional(option.disabled, 'boolean', `${path}.disabled`);
}

function validateTreeNodes(value: unknown, path: string): void {
  if (!Array.isArray(value)) invalidGuiData('GUI tree nodes must be an array.', path);
  value.forEach((item, index) => {
    const nodePath = `${path}[${index}]`;
    const node = recordAt(item, nodePath);
    if (typeof node.key !== 'string') invalidGuiData('GUI tree node key must be a string.', `${nodePath}.key`);
    if (typeof node.label !== 'string') invalidGuiData('GUI tree node label must be a string.', `${nodePath}.label`);
    if (node.value !== undefined) validateScalar(node.value, `${nodePath}.value`);
    optional(node.disabled, 'boolean', `${nodePath}.disabled`);
    if (node.children !== undefined) validateTreeNodes(node.children, `${nodePath}.children`);
  });
}

function validateScalar(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  invalidGuiData('GUI serialized values are limited to string, finite number, boolean, or null.', path);
}

function validateStyle(value: unknown, path: string): void {
  const style = recordAt(value, path);
  for (const [key, item] of Object.entries(style)) {
    if (key === 'backgroundColor' || key === 'hoverBackgroundColor' || key === 'borderColor' || key === 'color' || key === 'hoverColor') {
      if (typeof item !== 'string') invalidGuiData(`GUI style ${key} must be a string.`, `${path}.${key}`);
    } else if (key === 'opacity' || key === 'radius' || key === 'padding') {
      if (typeof item !== 'number' || !Number.isFinite(item)) invalidGuiData(`GUI style ${key} must be a finite number.`, `${path}.${key}`);
    } else {
      invalidGuiData('Unknown GUI style property.', `${path}.${key}`, { property: key });
    }
  }
}

function validateTheme(value: unknown, path: string): void {
  const theme = recordAt(value, path);
  optional(theme.fontFamily, 'string', `${path}.fontFamily`);
  finiteOptional(theme.fontSize, `${path}.fontSize`);
  finiteOptional(theme.radius, `${path}.radius`);
  if (theme.colors !== undefined) {
    const colors = recordAt(theme.colors, `${path}.colors`);
    for (const [key, color] of Object.entries(colors)) {
      if (typeof color !== 'string') invalidGuiData(`GUI theme color ${key} must be a string.`, `${path}.colors.${key}`);
    }
  }
}

function validateStringArray(value: unknown, path: string): void {
  if (!Array.isArray(value)) invalidGuiData('Expected an array of strings.', path);
  value.forEach((item, index) => {
    if (typeof item !== 'string') invalidGuiData('Expected a string.', `${path}[${index}]`);
  });
}

function isGuiLength(value: unknown): value is GuiLength {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && /^[-+]?\d+(?:\.\d+)?%$/.test(value);
}

function optional(value: unknown, expected: 'string' | 'boolean', path: string): void {
  if (value !== undefined && typeof value !== expected) invalidGuiData(`Expected ${expected}.`, path);
}

function finiteOptional(value: unknown, path: string): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) invalidGuiData('Expected a finite number.', path);
}

function recordAt(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidGuiData('Expected an object.', path);
  return value as Record<string, unknown>;
}

function invalidGuiData(message: string, path: string, context: Record<string, unknown> = {}): never {
  throw new EngineError(EngineErrorCode.SceneDataInvalid, message, {
    domain: ErrorDomain.Serialization,
    path,
    context: {
      format: GUI_SERIALIZATION_FORMAT,
      expectedVersion: GUI_SERIALIZATION_VERSION,
      ...context,
    },
    hint: 'Validate GUI payloads before persistence and regenerate fixtures after a format version change.',
    docsPath: 'errors/E_SCENE_DATA_INVALID',
  });
}
