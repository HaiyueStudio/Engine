import type { CharacterPass } from './CharacterPassRenderer';
import { SHADER_LANGUAGE_SHOWCASE } from './generated/showcase.generated';

type InspectorProgram = 'portable' | 'pbr' | 'character';
type InspectorTab = 'composition' | 'ir' | 'wgsl' | 'glsl' | 'abi';

interface SourceSpan {
  readonly sourceId: string;
  readonly generatedStartLine: number;
  readonly generatedEndLine: number;
  readonly sourceName?: string;
}

interface IrNodeView {
  readonly id: number;
  readonly operation: string;
  readonly type: { readonly dataType: string; readonly semantic: string };
  readonly source: { readonly sourceId: string };
}

interface IrEntryView {
  readonly stage: string;
  readonly name: string;
  readonly nodes: readonly IrNodeView[];
}

interface IrProgramView {
  readonly format: string;
  readonly version: number;
  readonly canonicalHash: string;
  readonly entries: readonly IrEntryView[];
}

export class InspectorPanel {
  private activeProgram: InspectorProgram = 'portable';
  private activeTab: InspectorTab = 'composition';
  private selectedSourceId: string = SHADER_LANGUAGE_SHOWCASE.graph.nodes[0]!.sourceId;
  private selectedCharacterPass: CharacterPass = 'forward';
  private readonly content: HTMLElement;
  private readonly tabs: HTMLButtonElement[];
  private readonly programTabs: HTMLButtonElement[];

  constructor(root: HTMLElement) {
    this.content = requiredElement(root, '[data-inspector-content]');
    this.tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-inspector-tab]')];
    this.programTabs = [...root.querySelectorAll<HTMLButtonElement>('[data-inspector-program]')];
    for (const button of this.tabs) {
      button.addEventListener('click', () => {
        const tab = button.dataset.inspectorTab;
        if (!isInspectorTab(tab)) return;
        this.activeTab = tab;
        this.render();
      });
    }
    for (const button of this.programTabs) {
      button.addEventListener('click', () => {
        const program = button.dataset.inspectorProgram;
        if (!isInspectorProgram(program)) return;
        this.activeProgram = program;
        this.selectedSourceId = program === 'portable'
          ? SHADER_LANGUAGE_SHOWCASE.graph.nodes[0]!.sourceId
          : program === 'pbr'
            ? `graph.${SHADER_LANGUAGE_SHOWCASE.pbr.graph.nodes[0]!.id}`
            : 'deformation.morph';
        this.render();
      });
    }
    this.render();
  }

  private selectSource(sourceId: string): void {
    this.selectedSourceId = sourceId;
    this.render();
  }

  private render(): void {
    for (const button of this.tabs) {
      const selected = button.dataset.inspectorTab === this.activeTab;
      button.dataset.active = String(selected);
      button.setAttribute('aria-selected', String(selected));
    }
    for (const button of this.programTabs) {
      const selected = button.dataset.inspectorProgram === this.activeProgram;
      button.dataset.active = String(selected);
      button.setAttribute('aria-selected', String(selected));
    }
    this.content.replaceChildren();
    if (this.activeTab === 'composition') this.renderComposition();
    else if (this.activeTab === 'ir') this.renderIr();
    else if (this.activeTab === 'wgsl') this.renderWgsl();
    else if (this.activeTab === 'glsl') this.renderGlsl();
    else this.renderAbi();
  }

  private renderComposition(): void {
    if (this.activeProgram === 'portable') {
      const nodes = SHADER_LANGUAGE_SHOWCASE.graph.nodes.map(node => ({
        label: node.label, operation: node.operation, sourceId: node.sourceId, category: node.category,
      }));
      this.renderGraph(nodes, sourceMappingSummary(this.selectedSourceId, portableIr(), SHADER_LANGUAGE_SHOWCASE.wgsl.sourceMap));
      return;
    }
    if (this.activeProgram === 'pbr') {
      const authored = SHADER_LANGUAGE_SHOWCASE.pbr.graph.nodes.map(node => ({
        label: node.id,
        operation: node.type.replace('haiyue.', ''),
        sourceId: `graph.${node.id}`,
        category: node.type.includes('texture') ? 'resource' : node.type.includes('color') ? 'color' : 'effect',
      }));
      const nodes = [
        ...authored,
        { label: 'MaterialSurface v1', operation: 'typed semantic slots + defaults', sourceId: '@material-surface.defaults', category: 'space' },
        { label: 'Metallic Roughness PBR', operation: 'GGX + Schlick + ambient', sourceId: '@lighting.metallic-roughness', category: 'math' },
        { label: 'Scene Fog', operation: 'post-lighting distance fog', sourceId: 'scene.fog', category: 'output' },
      ];
      this.renderGraph(nodes, sourceMappingSummary(this.selectedSourceId, pbrIr(), SHADER_LANGUAGE_SHOWCASE.pbr.wgsl.sourceMap));
      return;
    }
    const graph = element('div', 'composition-graph');
    for (const [index, node] of SHADER_LANGUAGE_SHOWCASE.character.program.nodes.entries()) {
      graph.append(graphButton(index, node.operation, `${node.input} → ${node.output}`, `deformation.${node.id}`, 'effect', sourceId => this.selectSource(sourceId)));
      graph.append(textElement('span', 'graph-arrow', '↓'));
    }
    const fanout = element('section', 'selection-detail');
    fanout.append(
      textElement('div', 'selection-detail__eyebrow', 'One deformation module → five derived passes'),
      textElement('code', '', SHADER_LANGUAGE_SHOWCASE.character.deformationModuleHash),
    );
    const passButtons = element('div', 'feature-chain');
    for (const pass of characterPasses()) {
      const button = textElement('button', 'feature-chip', pass) as HTMLButtonElement;
      button.type = 'button';
      button.dataset.selected = String(pass === this.selectedCharacterPass);
      button.addEventListener('click', () => {
        this.selectedCharacterPass = pass;
        this.render();
      });
      passButtons.append(button);
    }
    fanout.append(passButtons, textElement('p', '', 'morph → skinning → displacement 只定义一次；motion 同时读取 current/previous，同帧其余 Pass 只读取 current。'));
    this.content.append(graph, fanout);
  }

  private renderGraph(
    nodes: readonly { readonly label: string; readonly operation: string; readonly sourceId: string; readonly category: string }[],
    mapping: { readonly irNodeIds: readonly number[]; readonly wgslLines: string },
  ): void {
    const graph = element('div', 'composition-graph');
    for (const [index, node] of nodes.entries()) {
      graph.append(graphButton(index, node.label, node.operation, node.sourceId, node.category, sourceId => this.selectSource(sourceId)));
      if (index < nodes.length - 1) graph.append(textElement('span', 'graph-arrow', '↓'));
    }
    const selected = nodes.find(node => node.sourceId === this.selectedSourceId) ?? nodes[0]!;
    const detail = element('section', 'selection-detail');
    detail.append(
      textElement('div', 'selection-detail__eyebrow', 'Selected source provenance'),
      textElement('strong', '', selected.label),
      textElement('code', '', selected.sourceId),
      textElement('p', '', `Typed IR nodes ${mapping.irNodeIds.join(', ') || '—'} · WGSL lines ${mapping.wgslLines || '—'}`),
    );
    this.content.append(graph, detail);
  }

  private renderIr(): void {
    if (this.activeProgram === 'character') {
      const header = element('div', 'inspector-summary');
      header.append(
        metric('Kind', SHADER_LANGUAGE_SHOWCASE.character.program.kind),
        metric('Canonical', SHADER_LANGUAGE_SHOWCASE.character.program.canonicalHash.slice(0, 16)),
        metric('Morph targets', String(SHADER_LANGUAGE_SHOWCASE.character.program.morphTargetCount)),
        metric('Skin joints', String(SHADER_LANGUAGE_SHOWCASE.character.program.jointCount)),
      );
      const list = element('div', 'ir-list');
      for (const [index, node] of SHADER_LANGUAGE_SHOWCASE.character.program.nodes.entries()) {
        const row = element('button', 'ir-row') as HTMLButtonElement;
        row.type = 'button';
        row.append(
          textElement('code', 'ir-row__id', `#${index}`),
          textElement('strong', 'ir-row__operation', node.operation),
          textElement('code', 'ir-row__type', node.output),
          textElement('span', 'ir-row__source', `${node.input} → ${node.output}`),
        );
        list.append(row);
      }
      this.content.append(header, list);
      return;
    }
    this.renderTypedIr(this.activeProgram === 'portable' ? portableIr() : pbrIr());
  }

  private renderTypedIr(ir: IrProgramView): void {
    const header = element('div', 'inspector-summary');
    header.append(
      metric('Format', ir.format),
      metric('Version', String(ir.version)),
      metric('Nodes', String(ir.entries.reduce((total, entry) => total + entry.nodes.length, 0))),
      metric('Canonical', ir.canonicalHash.slice(0, 16)),
    );
    const list = element('div', 'ir-list');
    for (const entry of ir.entries) {
      list.append(textElement('h3', 'ir-entry-title', `${entry.stage} · ${entry.name}`));
      for (const node of entry.nodes) {
        const row = element('button', 'ir-row') as HTMLButtonElement;
        row.type = 'button';
        row.dataset.selected = String(node.source.sourceId === this.selectedSourceId);
        row.append(
          textElement('code', 'ir-row__id', `#${node.id}`),
          textElement('strong', 'ir-row__operation', node.operation),
          textElement('code', 'ir-row__type', `${node.type.dataType} · ${node.type.semantic}`),
          textElement('span', 'ir-row__source', node.source.sourceId),
        );
        row.addEventListener('click', () => this.selectSource(node.source.sourceId));
        list.append(row);
      }
    }
    this.content.append(header, list);
  }

  private renderWgsl(): void {
    if (this.activeProgram === 'portable') {
      this.renderCode(SHADER_LANGUAGE_SHOWCASE.wgsl.code, SHADER_LANGUAGE_SHOWCASE.wgsl.sourceMap, 'Portable WGSL');
    } else if (this.activeProgram === 'pbr') {
      this.renderCode(SHADER_LANGUAGE_SHOWCASE.pbr.wgsl.code, SHADER_LANGUAGE_SHOWCASE.pbr.wgsl.sourceMap, 'PBR Graph WGSL');
    } else {
      this.renderCode(generatedCharacterPass(this.selectedCharacterPass).code, [], `Character · ${this.selectedCharacterPass}`);
    }
  }

  private renderGlsl(): void {
    if (this.activeProgram !== 'portable') {
      this.renderBoundaryNotice(
        this.activeProgram === 'pbr' ? 'PBR Graph WebGL2 lowering is not claimed yet' : 'Character deformation WebGL2 lowering is not claimed yet',
        '阶段 14 只证明受限 vertex/fragment Typed IR 可行性；cross-stage varying、storage-buffer skinning、history 与 feature degradation 未完成时，不伪造 GLSL 输出。',
      );
      return;
    }
    let lineOffset = 0;
    const code: string[] = [];
    const spans: SourceSpan[] = [];
    for (const entry of SHADER_LANGUAGE_SHOWCASE.glsl.entries) {
      code.push(`// ── ${entry.stage.toUpperCase()} · ${entry.originalEntryPoint} ──`, entry.code.trimEnd(), '');
      for (const span of entry.sourceMap) {
        spans.push({
          ...span,
          generatedStartLine: span.generatedStartLine + lineOffset + 1,
          generatedEndLine: span.generatedEndLine + lineOffset + 1,
        });
      }
      lineOffset += entry.code.trimEnd().split('\n').length + 2;
    }
    this.renderCode(`${code.join('\n')}\n`, spans, 'GLSL ES 3.00');
  }

  private renderCode(code: string, sourceMap: readonly SourceSpan[], label: string): void {
    const selectedSpans = sourceMap.filter(span => span.sourceId === this.selectedSourceId);
    const header = element('div', 'code-header');
    header.append(
      textElement('strong', '', label),
      textElement('span', '', selectedSpans.length > 0
        ? `${this.selectedSourceId} · lines ${formatLines(selectedSpans)}`
        : this.activeProgram === 'character' ? SHADER_LANGUAGE_SHOWCASE.character.deformationModuleHash.slice(0, 20) : `${this.selectedSourceId} · inlined/DCE`),
    );
    const pre = element('pre', 'source-code');
    for (const [index, line] of code.trimEnd().split('\n').entries()) {
      const lineNumber = index + 1;
      const row = element('span', 'source-line');
      const selected = sourceMap.some(span => span.sourceId === this.selectedSourceId
        && lineNumber >= span.generatedStartLine && lineNumber <= span.generatedEndLine);
      row.dataset.selected = String(selected);
      row.append(textElement('span', 'source-line__number', String(lineNumber)), textElement('span', 'source-line__code', line || ' '));
      pre.append(row);
    }
    this.content.append(header, pre);
    requestAnimationFrame(() => pre.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'center' }));
  }

  private renderAbi(): void {
    if (this.activeProgram === 'portable') {
      const summary = element('div', 'inspector-summary');
      summary.append(
        metric('Logical spaces', 'material → group 2'),
        metric('Resources', String(SHADER_LANGUAGE_SHOWCASE.metrics.resourceCount)),
        metric('WGSL layout', `${SHADER_LANGUAGE_SHOWCASE.wgsl.reflection.uniformBlocks[0]!.byteSize} bytes`),
        metric('GLSL layout', `${SHADER_LANGUAGE_SHOWCASE.glsl.uniformBlocks[0]!.layout.byteSize} bytes std140`),
      );
      this.content.append(summary, abiResourceTable('WebGPU resources', SHADER_LANGUAGE_SHOWCASE.wgsl.reflection.resources));
      this.content.append(uniformTable('WGSL host layout', SHADER_LANGUAGE_SHOWCASE.wgsl.reflection.uniformBlocks[0]!));
      this.content.append(uniformTable('GLSL std140 layout', SHADER_LANGUAGE_SHOWCASE.glsl.uniformBlocks[0]!.layout));
      return;
    }
    if (this.activeProgram === 'pbr') {
      const summary = element('div', 'inspector-summary');
      summary.append(
        metric('Frame', 'group 0'), metric('Object', 'group 1'), metric('Material', 'group 2'),
        metric('Vertex semantics', String(SHADER_LANGUAGE_SHOWCASE.pbr.vertexSemantics.length)),
      );
      this.content.append(summary, abiResourceTable('PBR symbolic resources', SHADER_LANGUAGE_SHOWCASE.pbr.wgsl.reflection.resources));
      this.content.append(uniformTable('Object transform', SHADER_LANGUAGE_SHOWCASE.pbr.wgsl.objectUniformBlock));
      for (const block of SHADER_LANGUAGE_SHOWCASE.pbr.wgsl.reflection.uniformBlocks) this.content.append(uniformTable(block.id, block));
      return;
    }
    const pass = generatedCharacterPass(this.selectedCharacterPass);
    const summary = element('div', 'inspector-summary');
    summary.append(
      metric('Pass', this.selectedCharacterPass),
      metric('History', pass.reflection.historySemantics),
      metric('Shared module', pass.deformationModuleHash.slice(0, 16)),
      metric('Attributes', String(pass.reflection.vertexAttributes.length)),
    );
    this.content.append(summary, abiResourceTable('Shared deformation resources', pass.reflection.resources));
    for (const block of pass.reflection.uniformBlocks) this.content.append(uniformTable(block.id, block));
    const attributes = tableShell('Reflected vertex ABI', ['Semantic', 'Location', 'Format']);
    for (const attribute of pass.reflection.vertexAttributes) {
      appendTableRow(attributes, [attribute.semantic, String(attribute.location), attribute.format]);
    }
    this.content.append(attributes.parentElement!);
  }

  private renderBoundaryNotice(title: string, description: string): void {
    const notice = element('section', 'selection-detail');
    notice.append(
      textElement('div', 'selection-detail__eyebrow', 'Explicit capability boundary'),
      textElement('strong', '', title),
      textElement('p', '', description),
      textElement('code', '', 'productRendererContract = webgpu-only-unchanged'),
    );
    this.content.append(notice);
  }
}

function graphButton(
  index: number,
  label: string,
  operation: string,
  sourceId: string,
  category: string,
  select: (sourceId: string) => void,
): HTMLButtonElement {
  const button = element('button', `graph-node graph-node--${category}`) as HTMLButtonElement;
  button.type = 'button';
  button.append(
    textElement('span', 'graph-node__index', String(index + 1).padStart(2, '0')),
    textElement('strong', 'graph-node__label', label),
    textElement('code', 'graph-node__operation', operation),
  );
  button.addEventListener('click', () => select(sourceId));
  return button;
}

function sourceMappingSummary(
  sourceId: string,
  ir: IrProgramView,
  sourceMap: readonly SourceSpan[],
): { readonly irNodeIds: readonly number[]; readonly wgslLines: string } {
  const irNodeIds: number[] = [];
  for (const entry of ir.entries) for (const node of entry.nodes) {
    if (node.source.sourceId === sourceId) irNodeIds.push(node.id);
  }
  return {
    irNodeIds,
    wgslLines: formatLines(sourceMap.filter(span => span.sourceId === sourceId)),
  };
}

function portableIr(): IrProgramView {
  return SHADER_LANGUAGE_SHOWCASE.ir as unknown as IrProgramView;
}

function pbrIr(): IrProgramView {
  return SHADER_LANGUAGE_SHOWCASE.pbr.ir as unknown as IrProgramView;
}

function generatedCharacterPass(pass: CharacterPass): (typeof SHADER_LANGUAGE_SHOWCASE.character.passes)[CharacterPass] {
  return SHADER_LANGUAGE_SHOWCASE.character.passes[pass];
}

function characterPasses(): readonly CharacterPass[] {
  return SHADER_LANGUAGE_SHOWCASE.character.passOrder;
}

function abiResourceTable(
  label: string,
  resources: readonly { readonly id: string; readonly space: string; readonly group: number; readonly binding: number }[],
): HTMLElement {
  const table = tableShell(label, ['Resource', 'Space', 'Group', 'Binding']);
  for (const resource of resources) appendTableRow(table, [resource.id, resource.space, String(resource.group), String(resource.binding)]);
  return table.parentElement!;
}

function uniformTable(
  label: string,
  block: { readonly fields: readonly { readonly name: string; readonly type: string; readonly offset: number; readonly size: number }[] },
): HTMLElement {
  const table = tableShell(label, ['Field', 'Type', 'Offset', 'Size']);
  for (const field of block.fields) appendTableRow(table, [field.name, field.type, String(field.offset), String(field.size)]);
  return table.parentElement!;
}

function tableShell(label: string, headers: readonly string[]): HTMLTableElement {
  const section = element('section', 'abi-card');
  section.append(textElement('h3', '', label));
  const table = element('table', 'abi-table') as HTMLTableElement;
  const head = table.createTHead().insertRow();
  for (const header of headers) head.append(textElement('th', '', header));
  table.createTBody();
  section.append(table);
  return table;
}

function appendTableRow(table: HTMLTableElement, values: readonly string[]): void {
  const row = table.tBodies[0]!.insertRow();
  for (const value of values) row.append(textElement('td', '', value));
}

function metric(label: string, value: string): HTMLElement {
  const node = element('div', 'inspector-metric');
  node.append(textElement('span', '', label), textElement('strong', '', value));
  return node;
}

function formatLines(spans: readonly { readonly generatedStartLine: number; readonly generatedEndLine: number }[]): string {
  return spans.map(span => span.generatedStartLine === span.generatedEndLine
    ? String(span.generatedStartLine)
    : `${span.generatedStartLine}–${span.generatedEndLine}`).join(', ');
}

function isInspectorTab(value: string | undefined): value is InspectorTab {
  return value === 'composition' || value === 'ir' || value === 'wgsl' || value === 'glsl' || value === 'abi';
}

function isInspectorProgram(value: string | undefined): value is InspectorProgram {
  return value === 'portable' || value === 'pbr' || value === 'character';
}

function requiredElement<T extends HTMLElement>(root: HTMLElement, selector: string): T {
  const value = root.querySelector<T>(selector);
  if (!value) throw new Error(`Shader Language Lab is missing ${selector}.`);
  return value;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function textElement<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text: string): HTMLElementTagNameMap[K] {
  const node = element(tag, className);
  node.textContent = text;
  return node;
}
