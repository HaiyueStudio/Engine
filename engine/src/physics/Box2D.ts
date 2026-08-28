/// <reference path="../types/box2d-umd.d.ts" />
import * as box2d from 'box2d.ts/dist/box2d.umd.js';

export { box2d };

export type B2Body = InstanceType<typeof box2d.b2Body>;
export type B2Contact = import('box2d.ts/dist/box2d.umd.js').b2Contact;
export type B2Fixture = import('box2d.ts/dist/box2d.umd.js').b2Fixture;
export type B2Joint = InstanceType<typeof box2d.b2Joint>;
export type B2Shape = InstanceType<typeof box2d.b2Shape>;
export type B2Vec2 = InstanceType<typeof box2d.b2Vec2>;
export type B2World = InstanceType<typeof box2d.b2World>;
