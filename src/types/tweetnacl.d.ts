// Minimal type declarations for tweetnacl (registry lacks @types/tweetnacl).
// Only the APIs used by the Jupiter Trigger client are declared.
declare module 'tweetnacl' {
  export interface SignAPI {
    detached(message: Uint8Array, secretKey: Uint8Array): Uint8Array;
    detached: {
      verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean;
    } & ((message: Uint8Array, secretKey: Uint8Array) => Uint8Array);
  }

  export const sign: {
    (message: Uint8Array, secretKey: Uint8Array): Uint8Array;
    detached: (message: Uint8Array, secretKey: Uint8Array) => Uint8Array;
  };

  const nacl: {
    sign: {
      (message: Uint8Array, secretKey: Uint8Array): Uint8Array;
      detached: (message: Uint8Array, secretKey: Uint8Array) => Uint8Array;
    };
  };

  export default nacl;
}
