import type {
  AnimationComponent, AnimationLayerEffect, AnimationNode, AnimationSprite2DComponent,
  AnimationText2DComponent, AnimationVectorGradientPaint, AnimationVectorShapeComponent,
  AnimationVectorSolidPaint,
} from '@haiyue/animation-spec';

/** Classify parsed core inputs once, without guessing from property names or scanning numeric payloads. */
export function coreNodeHasTimeDependency(node: AnimationNode): boolean {
  const composite = node.composite;
  return (node.components ?? []).some(coreComponentHasTimeDependency)
    || (node.effects ?? []).some(effectHasTimeDependency)
    || !!composite && ('layers' in composite ? composite.layers : [composite]).some(layer => !!layer.expansionTrack);
}

export function coreComponentHasTimeDependency(component: AnimationComponent): boolean {
  switch (component.type) {
    case 'org.haiyue.vector-path-morph@1': return true;
    case 'sprite2d': return !!(component as AnimationSprite2DComponent).uvRectTrack;
    case 'text2d': {
      const text = component as AnimationText2DComponent;
      return !!text.paragraphSpacingTrack || !!text.documents?.length || !!text.animators?.length || !!text.expression
        || !!text.styleRuns?.some(run => !!run.fontSizeTrack || !!run.lineHeightTrack || !!run.trackingTrack);
    }
    case 'org.haiyue.vector-shape@1': {
      const shape = component as AnimationVectorShapeComponent, stroke = shape.stroke;
      return !!shape.morph || paintHasTimeDependency(shape.fill)
        || !!stroke && (!!stroke.colorTrack || !!stroke.opacityTrack || !!stroke.widthTrack || !!stroke.dashOffsetTrack || paintHasTimeDependency(stroke.gradient))
        || !!shape.modifiers?.some(modifier => modifier.kind === 'trim-path'
          ? !!modifier.startTrack || !!modifier.endTrack || !!modifier.offsetTrack : !!modifier.radiusTrack);
    }
    default: return false; // Static primitives and legacy strokes; custom extension callbacks have a separate owner.
  }
}

function paintHasTimeDependency(paint: AnimationVectorSolidPaint | AnimationVectorGradientPaint | undefined): boolean {
  if (!paint) return false;
  return !!paint.opacityTrack || (paint.kind === 'solid' ? !!paint.colorTrack : !!paint.startTrack || !!paint.endTrack || !!paint.stopsTrack);
}

function effectHasTimeDependency(effect: AnimationLayerEffect): boolean {
  switch (effect.kind) {
    case 'tint': return !!effect.blackTrack || !!effect.whiteTrack || !!effect.amountTrack;
    case 'fill': return !!effect.colorTrack || !!effect.opacityTrack;
    case 'opacity': return !!effect.opacityTrack;
    case 'color-matrix': return !!effect.matrixTrack;
    case 'blur': return !!effect.radiusTrack;
    case 'drop-shadow': return !!effect.colorTrack || !!effect.opacityTrack || !!effect.offsetTrack || !!effect.blurTrack;
  }
}
