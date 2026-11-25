// saxes 6.0.0 ships unconstrained handler generics that fail TS 5.9's
// declaration checks. Describe the plain XML events used by the adapter.
export declare class SaxesParser {
  on(event: 'doctype' | 'processinginstruction' | 'error', handler: () => void): void;
  on(event: 'opentag' | 'closetag', handler: (tag: { name: string; attributes: Record<string, string> }) => void): void;
  write(xml: string): this;
  close(): this;
}
