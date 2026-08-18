import type { AnimationParticle2DComponent } from '@haiyue/animation-spec';
import { ParticleEmitter2D, type ParticleEmitter2DOptions } from '@haiyue/engine/components';

/** Single runtime mapping from screen-y-down HYA data to the engine's y-up emitter. */
export function particle2DDescriptorToEmitterOptions(
  component: Readonly<AnimationParticle2DComponent>,
): ParticleEmitter2DOptions {
  return {
    maxParticles: component.maxParticles,
    emissionRate: component.emissionRate,
    burst: component.burst ?? 0,
    duration: component.duration ?? Number.POSITIVE_INFINITY,
    loop: component.loop ?? true,
    seed: component.seed ?? 1,
    lifetime: component.lifetime,
    speed: component.speed,
    angle: [-component.angle[1], -component.angle[0]],
    gravity: [component.gravity?.[0] ?? 0, -(component.gravity?.[1] ?? 20)],
    startSize: component.startSize,
    endSize: component.endSize,
    startColor: component.startColor,
    endColor: component.endColor,
    shape: component.shape ?? 'point',
    shapeSize: component.shapeSize ?? [0, 0],
    shapeRadius: component.shapeRadius ?? 0,
    blendMode: component.blendMode ?? 'normal',
    radial: component.radial ?? true,
  };
}

export function createParticle2DEmitter(
  component: Readonly<AnimationParticle2DComponent>,
): ParticleEmitter2D {
  return new ParticleEmitter2D(particle2DDescriptorToEmitterOptions(component));
}
