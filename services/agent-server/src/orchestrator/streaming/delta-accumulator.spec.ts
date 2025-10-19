import { DeltaAccumulator } from './delta-accumulator';

describe('DeltaAccumulator', () => {
  it('returns full text for first occurrence', () => {
    const accumulator = new DeltaAccumulator();
    expect(accumulator.computeDelta('key', 'hello')).toBe('hello');
  });

  it('returns incremental suffix when text grows', () => {
    const accumulator = new DeltaAccumulator();
    accumulator.computeDelta('key', 'Hello');
    expect(accumulator.computeDelta('key', 'Hello, world')).toBe(', world');
  });

  it('returns full text when content diverges', () => {
    const accumulator = new DeltaAccumulator();
    accumulator.computeDelta('key', 'foo');
    expect(accumulator.computeDelta('key', 'bar')).toBe('bar');
  });
});
