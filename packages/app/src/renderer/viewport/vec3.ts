/**
 * vec3.ts — read a scene-file vector into Three.js.
 *
 * `vec3Schema` is `z.array(n).length(3)`, so its inferred type is `number[]`,
 * not a tuple — under `noUncheckedIndexedAccess` every element read is
 * `number | undefined`. Spreading that into `position.set(...)` does not
 * typecheck, and destructuring does not either.
 *
 * The obvious response is a non-null assertion at each of the nine sites. That
 * would be a lie the type system is right to refuse: the value came out of JSON
 * and a hand-written `scene.json` with a two-component position is exactly the
 * case SPEC §4.2 says must fail loudly. This module makes the check explicit and
 * in one place, so a malformed vector produces one message naming the field
 * rather than nine `NaN`s in a matrix.
 */

/** Read a 3-component scene vector, or throw naming what was wrong. */
export function readVec3(value: readonly number[], field: string): [number, number, number] {
  if (value.length !== 3) {
    throw new Error(
      `${field} must have exactly 3 components (x, y, z), got ${value.length}. ` +
        'The scene file is invalid and was not written by saveScene.',
    );
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

/** Set a Three.js vector-like target from a scene vector. */
export function setVec3(
  target: { set(x: number, y: number, z: number): unknown },
  value: readonly number[],
  field: string,
): void {
  const [x, y, z] = readVec3(value, field);
  target.set(x, y, z);
}