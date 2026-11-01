import assert from 'node:assert/strict';
import test from 'node:test';
import {chromeAudioArguments} from './chrome-runner.mjs';
test('existing automated browser audio keeps its exact silent graph arguments',()=>{for(const presentation of [null,{mode:'visible',width:1000,height:800}])assert.deepEqual(chromeAudioArguments('silent',presentation),['--mute-audio','--autoplay-policy=no-user-gesture-required']);assert.deepEqual(chromeAudioArguments(),['--mute-audio','--autoplay-policy=no-user-gesture-required']);});
test('physical audio preserves normal user gesture policy and requires an explicit visible window',()=>{assert.deepEqual(chromeAudioArguments('interactive',{mode:'visible'}),[]);for(const [mode,presentation]of [['interactive',null],['interactive',{mode:'hidden'}],['unmuted',{mode:'visible'}],['',null]])assert.throws(()=>chromeAudioArguments(mode,presentation));});
