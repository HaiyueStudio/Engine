import { Entity, HaiyueEngine } from '@haiyue/engine';
import {
  GuiButton,
  GuiCheckbox,
  GuiInput,
  GuiLabel,
  GuiProgress,
  GuiRadio,
  GuiRoot,
  GuiSelect,
  GuiSlider,
  GuiSwitch,
  GuiTooltip,
  GuiTree,
} from '@haiyue/engine/gui';

async function main() {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const clicksEl = document.getElementById('clicks')!;
  const checkboxEl = document.getElementById('checkbox')!;
  const switchEl = document.getElementById('switch')!;
  const sliderEl = document.getElementById('slider')!;
  const inputEl = document.getElementById('input')!;
  const radioEl = document.getElementById('radio')!;
  const selectEl = document.getElementById('select')!;
  const treeEl = document.getElementById('tree')!;
  const focusEl = document.getElementById('focus')!;
  const hoverEl = document.getElementById('hover')!;

  const engine = new HaiyueEngine({
    canvas,
    clearColor: { r: 0.02, g: 0.04, b: 0.08, a: 1 },
  });
  await engine.init();

  const scene = engine.createScene({
    name: 'gui-runtime',
    render3D: false,
    gui: { loadOp: 'clear' },
    pipelineLabel: 'GuiRuntimeRenderPipeline',
  });
  const guiEntity = new Entity('gui');
  const guiRoot = new GuiRoot();
  guiEntity.addComponent(guiRoot);
  scene.add(guiEntity);
  const guiSystem = scene.guiSystem!;

  guiRoot.add(new GuiLabel({
    id: 'heading',
    x: 24,
    y: 150,
    width: 300,
    height: 36,
    text: 'Engine GUI controls',
    fontSize: 24,
    autoWidth: true,
    style: { color: '#93c5fd', padding: 4 },
  }));

  let clicks = 0;
  const button = guiRoot.add(new GuiButton({
    id: 'button',
    x: 24,
    y: 200,
    width: 120,
    height: 36,
    text: 'Button',
    style: { hoverBackgroundColor: '#3b82f6', hoverColor: '#ffffff' },
    onClick: () => {
      clicks += 1;
      clicksEl.textContent = String(clicks);
    },
  }));

  const checkbox = guiRoot.add(new GuiCheckbox({
    id: 'checkbox',
    x: 24,
    y: 250,
    width: 150,
    height: 30,
    label: 'Checkbox',
    onChange: (value) => {
      checkboxEl.textContent = String(value);
    },
  }));

  const switchControl = guiRoot.add(new GuiSwitch({
    id: 'switch',
    x: 24,
    y: 294,
    onChange: (value) => {
      switchEl.textContent = String(value);
    },
  }));

  let progress: GuiProgress;
  const slider = guiRoot.add(new GuiSlider({
    id: 'slider',
    x: 24,
    y: 342,
    width: 220,
    value: 25,
    min: 0,
    max: 100,
    step: 1,
    onChange: (value) => {
      sliderEl.textContent = String(value);
      progress.setValue(value);
    },
  }));

  progress = guiRoot.add(new GuiProgress({
    id: 'progress',
    x: 24,
    y: 386,
    width: 220,
    height: 18,
    value: 25,
    showText: true,
  }));

  const input = guiRoot.add(new GuiInput({
    id: 'input',
    x: 24,
    y: 422,
    width: 220,
    value: 'hello',
    placeholder: 'type text',
    onChange: (value) => {
      inputEl.textContent = value;
    },
  }));

  const radioSmall = guiRoot.add(new GuiRadio({
    id: 'radio-small',
    x: 24,
    y: 466,
    width: 90,
    label: 'Small',
    group: 'size',
    value: 'small',
    checked: true,
    onChange: (value) => {
      radioEl.textContent = value;
    },
  }));
  const radioMedium = guiRoot.add(new GuiRadio({
    id: 'radio-medium',
    x: 120,
    y: 466,
    width: 105,
    label: 'Medium',
    group: 'size',
    value: 'medium',
    onChange: (value) => {
      radioEl.textContent = value;
    },
  }));
  const radioLarge = guiRoot.add(new GuiRadio({
    id: 'radio-large',
    x: 232,
    y: 466,
    width: 90,
    label: 'Large',
    group: 'size',
    value: 'large',
    onChange: (value) => {
      radioEl.textContent = value;
    },
  }));

  const select = guiRoot.add(new GuiSelect({
    id: 'select',
    x: 360,
    y: 200,
    width: 190,
    value: 'tetris',
    options: [
      { label: 'Tetris', value: 'tetris' },
      { label: 'Billiards', value: 'billiards' },
      { label: 'Minesweeper', value: 'minesweeper' },
      { label: '2048', value: '2048' },
    ],
    onChange: (value) => {
      selectEl.textContent = String(value);
    },
  }));

  const tooltip = guiRoot.add(new GuiTooltip({
    id: 'button-tooltip',
    target: button,
    content: 'Click callback test',
    placement: 'right',
    width: 160,
    height: 30,
  }));

  const tree = guiRoot.add(new GuiTree({
    id: 'tree',
    x: 360,
    y: 300,
    width: 260,
    height: 170,
    expandedKeys: ['games'],
    selectedKey: 'tetris',
    nodes: [
      {
        key: 'games',
        label: 'Games',
        children: [
          { key: 'tetris', label: 'Tetris' },
          { key: 'billiards', label: 'Billiards' },
          { key: 'minesweeper', label: 'Minesweeper' },
        ],
      },
      {
        key: 'tools',
        label: 'Tools',
        children: [
          { key: 'camera', label: 'Camera' },
          { key: 'settings', label: 'Settings' },
        ],
      },
    ],
    onSelect: (node) => {
      treeEl.textContent = node.label;
    },
  }));

  function updateStatus() {
    const focused = guiSystem.focus.focused;
    const hovered = [
      button,
      checkbox,
      switchControl,
      slider,
      progress,
      input,
      radioSmall,
      radioMedium,
      radioLarge,
      select,
      tooltip,
      tree,
    ].find((item) => item.hovered);
    focusEl.textContent = focused?.id ?? 'none';
    hoverEl.textContent = hovered?.id ?? 'none';
  }

  engine.switchScene(scene);
  engine.on('after-update', () => {
    updateStatus();
  });

  engine.run();
}

main().catch((error) => {
  console.error(error);
});
