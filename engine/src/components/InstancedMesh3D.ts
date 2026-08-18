import { Component, UniqueCheckType } from '../ecs/Component';
import type { Geometry3D } from '../geometry/Geometry3D';
import type { InstancedMaterial } from '../material/InstancedMaterial';

export class InstancedMesh3D extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('InstancedMesh3D');

  geometry: Geometry3D;
  material: InstancedMaterial;

  constructor(geometry: Geometry3D, material: InstancedMaterial) {
    super('InstancedMesh3D');
    this.geometry = geometry;
    this.material = material;
  }
}
