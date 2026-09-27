// Minimal stand-in for the failproofai package so the policies can be unit-tested.
export const registry = [];
export const customPolicies = { add: (p) => registry.push(p) };
export const allow = () => ({ d: "allow" });
export const deny = (r) => ({ d: "deny", r });
export const instruct = (r) => ({ d: "instruct", r });
