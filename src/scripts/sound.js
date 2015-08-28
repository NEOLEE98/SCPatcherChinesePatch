'use strict';

const _id = Symbol('id');
const _path = Symbol('path');
const _buffer = Symbol('buffer');
const _soundManager = Symbol('sound manager');

export default class Sound {

  constructor(soundManager, id, path, buffer) {
    this[_soundManager] = soundManager;
    this[_id] = id;
    this[_path] = path;
    this[_buffer] = buffer;
  }

  get id() {
    return this[_id];
  }

  get path() {
    return this[_path];
  }

  get buffer() {
    return this[_buffer];
  }

  play(options) {
    const _options = Object.assign({}, { loop: false }, options),
          sound = this[_soundManager].context.createBufferSource();

    sound.buffer = this[_buffer];
    sound.connect(this[_soundManager].gain);
    sound.loop = _options.loop;
    sound.noteOn(0);
  }

}