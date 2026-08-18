import { ComponentWithData, UniqueCheckType } from '../ecs/Component';
import { Geometry2D } from '../geometry/Geometry2D';
import { Material2D } from '../material/Material2D';
import { ColorSRGB } from '../color/ColorSRGB';

export interface Mesh2DData {
  geometry: Geometry2D;
  material: Material2D;
}

export class Mesh2D extends ComponentWithData<Mesh2DData> {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol    = Symbol.for('Mesh2D');
  static editor = {
    fields: {
      geometry: {
        type: 'asset-ref',
        label: 'Geometry',
        assetType: 'geometry2d',
        get: (component: Mesh2D) => String(component.geometry.id),
        set: (component: Mesh2D, value: unknown) => {
          if (value instanceof Geometry2D) component.geometry = value;
        },
        validate: (value: unknown) => String(value ?? '').trim() ? null : 'Geometry is required.',
      },
      material: {
        type: 'asset-ref',
        label: 'Material',
        assetType: 'material2d',
        get: (component: Mesh2D) => String(component.material.id),
        set: (component: Mesh2D, value: unknown) => {
          if (value instanceof Material2D) component.material = value;
        },
        validate: (value: unknown) => String(value ?? '').trim() ? null : 'Material is required.',
      },
      materialColor: {
        type: 'color',
        label: 'Color',
        get: (component: Mesh2D) => component.material.color,
        set: (component: Mesh2D, value: unknown) => {
          if (!(value instanceof ColorSRGB)) return;
          const alpha = component.material.color.a;
          component.material.color = value;
          component.material.color.a = alpha;
        },
      },
      materialAlpha: {
        type: 'number',
        label: 'Alpha',
        min: 0,
        max: 1,
        step: 0.01,
        get: (component: Mesh2D) => component.material.color.a,
        set: (component: Mesh2D, value: unknown) => {
          const alpha = Number(value);
          if (Number.isFinite(alpha)) component.material.color.a = Math.max(0, Math.min(1, alpha));
        },
      },
      materialBlending: {
        type: 'select',
        label: 'Blending',
        options: [
          { label: 'None', value: 'none' },
          { label: 'Normal', value: 'normal' },
          { label: 'Additive', value: 'additive' },
        ],
        get: (component: Mesh2D) => component.material.blending,
        set: (component: Mesh2D, value: unknown) => {
          if (value === 'none' || value === 'normal' || value === 'additive') component.material.blending = value;
        },
      },
    },
  };

  constructor(geometry: Geometry2D, material?: Material2D) {
    super({ geometry, material: material ?? new Material2D() }, 'Mesh2D');
  }

  get geometry(): Geometry2D {
    return this.data.geometry;
  }

  set geometry(value: Geometry2D) {
    this.data.geometry = value;
  }

  get material(): Material2D {
    return this.data.material;
  }

  set material(value: Material2D) {
    this.data.material = value;
  }

  override clone(): Mesh2D {
    const mesh = new Mesh2D(this.geometry, this.material);
    mesh.disabled = this.disabled;
    return mesh;
  }
}
