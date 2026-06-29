import { describe, it, expect } from 'vitest';
import { TrivialMessageDetector } from '../ingestion/TrivialMessageDetector.js';

describe('TrivialMessageDetector', () => {
  const detector = new TrivialMessageDetector();

  // ── Trivial messages ──

  describe('greetings → trivial', () => {
    const greetings = [
      'Hello', 'hello', 'Hi', 'hi', 'Hey', 'hey',
      'Good morning', 'good morning', 'Good evening', 'Good night',
      'Guten Morgen', 'guten morgen', 'Hallo',
      'Hello!', 'Hi!', 'Hey!',
    ];

    for (const msg of greetings) {
      it(`"${msg}" is trivial`, () => {
        const result = detector.check(msg);
        expect(result.isTrivial).toBe(true);
        expect(result.reason).toBe('greeting');
      });
    }
  });

  describe('thanks → trivial', () => {
    const thanks = [
      'Thx', 'Thanks', 'thanks', 'Thank you',
    ];

    for (const msg of thanks) {
      it(`"${msg}" is trivial`, () => {
        const result = detector.check(msg);
        expect(result.isTrivial).toBe(true);
        expect(result.reason).toBe('thanks');
      });
    }
  });

  describe('confirmations → trivial', () => {
    const confirmations = [
      'Yes', 'yes', 'No', 'no', 'Ok', 'ok', 'Okay', 'okay',
      'Clear', 'clear', 'Understood', 'Exactly', 'Right',
      'Good', 'Great', 'Cool', 'Nice', 'Top',
      'Perfect', 'Check', 'Done',
    ];

    for (const msg of confirmations) {
      it(`"${msg}" is trivial`, () => {
        const result = detector.check(msg);
        expect(result.isTrivial).toBe(true);
        expect(result.reason).toBe('confirmation');
      });
    }
  });

  describe('emoji-only → trivial', () => {
    const emojis = [
      '👍', '😊', '🎉', '❤️', '👍👍👍',
      '😊 🎉', '🚀 💯',
    ];

    for (const msg of emojis) {
      it(`"${msg}" is trivial`, () => {
        const result = detector.check(msg);
        expect(result.isTrivial).toBe(true);
        expect(result.reason).toBe('emoji_only');
      });
    }
  });

  describe('empty / whitespace → trivial', () => {
    it('"" is trivial', () => {
      const result = detector.check('');
      expect(result.isTrivial).toBe(true);
      expect(result.reason).toBe('too_short');
    });

    it('"   " is trivial', () => {
      const result = detector.check('   ');
      expect(result.isTrivial).toBe(true);
      expect(result.reason).toBe('too_short');
    });
  });

  describe('commands → trivial', () => {
    const commands = ['/help', '/model', '/status', '/new', '/tools'];

    for (const msg of commands) {
      it(`"${msg}" is trivial`, () => {
        const result = detector.check(msg);
        expect(result.isTrivial).toBe(true);
        expect(result.reason).toBe('command');
      });
    }
  });

  // ── Non-trivial messages ──

  describe('substantive messages → NOT trivial', () => {
    const substantive = [
      'I work at Google',
      'Where does Alex live?',
      'My name is Alex',
      'I live in London and work as CTO',
      'Berlin is a beautiful city',
      'Can you tell me something about Semantification?',
      'What do you know about me?',
      'I am interested in Knowledge Graphs',
      'Thanks, I work at Google',           // starts with thanks but has content
      'Hello, my name is Alex Smith',      // starts with hello but has content
      'Ok, tell me something about RDF',    // starts with ok but has content
    ];

    for (const msg of substantive) {
      it(`"${msg}" is NOT trivial`, () => {
        const result = detector.check(msg);
        expect(result.isTrivial).toBe(false);
      });
    }
  });

  describe('questions → NOT trivial', () => {
    const questions = [
      'Who am I?',
      'What is Ontofelia?',
      'Where is Berlin?',
      'What is your name?',
    ];

    for (const msg of questions) {
      it(`"${msg}" is NOT trivial`, () => {
        const result = detector.check(msg);
        expect(result.isTrivial).toBe(false);
      });
    }
  });
});
