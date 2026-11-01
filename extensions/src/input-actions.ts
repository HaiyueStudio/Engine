export type {InputBindingSample,InputBindingConflict,InputBindingProfileData,InputBindingProfileOptions,InputBindingProfile} from './input-actions/types.js';
import {BindingProfile} from './input-actions/BindingProfile.js';
import type {InputBindingProfileOptions,InputBindingProfile} from './input-actions/types.js';
export function createInputBindingProfile(options:InputBindingProfileOptions):InputBindingProfile {return new BindingProfile(options);}
