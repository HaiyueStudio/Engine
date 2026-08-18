import { ComponentWithData, UniqueCheckType } from '../ecs/Component';
import { Geometry3D } from '../geometry/Geometry3D';
import { Material } from '../material/Material';
import { BasicMaterial } from '../material/BasicMaterial';

export interface Mesh3DData {
  geometry: Geometry3D;
  material: Material;
}

export class Mesh3D extends ComponentWithData<Mesh3DData> {
  static override UniqueCheckType =
    UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Mesh3D');
  static editor = {
    fields: {
      geometry: {
        type: 'asset-ref',
        label: 'Geometry',
        group: 'Assets',
        assetType: 'geometry3d',
        get: (component: Mesh3D) => String(component.geometry.id),
        set: (component: Mesh3D, value: unknown) => {
          if (value instanceof Geometry3D) component.geometry = value;
        },
        validate: (value: unknown) => String(value ?? '').trim() ? null : 'Geometry is required.',
      },
      material: {
        type: 'asset-ref',
        label: 'Material',
        group: 'Assets',
        assetType: 'material3d',
        get: (component: Mesh3D) => String(component.material.id),
        set: (component: Mesh3D, value: unknown) => {
          if (value instanceof Material) component.material = value;
        },
        validate: (value: unknown) => String(value ?? '').trim() ? null : 'Material is required.',
      },
    },
  };

  constructor(geometry: Geometry3D, material?: Material) {
    super(
      { geometry, material: material ?? new BasicMaterial() },
      'Mesh3D',
    );
  }

  get geometry(): Geometry3D {
    return this.data.geometry;
  }

  set geometry(g: Geometry3D) {
    if (this.data.geometry === g) return;
    this.data.geometry = g;
    this._notifyChanged();
  }

  get material(): Material {
    return this.data.material;
  }

  set material(m: Material) {
    if (this.data.material === m) return;
    this.data.material = m;
    this._notifyChanged();
  }

  private _notifyChanged(): void {
    for (const entity of this.usedBy) entity.world?.notifyEntityComponentChanged(entity, this);
  }

  override clone(): Mesh3D {
    const mesh = new Mesh3D(this.geometry, this.material);
    mesh.disabled = this.disabled;
    return mesh;
  }
}
