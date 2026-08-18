import { Component, UniqueCheckType } from '../ecs/Component';
import type { LineGeometry } from '../geometry/LineGeometry';
import type { LineMaterial } from '../material/LineMaterial';

export class Line3D extends Component {
  static override UniqueCheckType = UniqueCheckType.SYMBOL | UniqueCheckType.REPLACE;
  static override UniqueSymbol = Symbol.for('Line3D');

  geometry: LineGeometry;
  material: LineMaterial;

  constructor(geometry: LineGeometry, material: LineMaterial) {
    super('Line3D');
    this.geometry = geometry;
    this.material = material;
  }
}
