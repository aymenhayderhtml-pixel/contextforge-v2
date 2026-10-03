/**
 * test/viewport/markers.test.ts — failure markers and the vec3 boundary.
 *
 * A failed prefab and a failed `.glb` both resolve to the same visible object.
 * If that object is not distinguishable from real geometry and not replaceable,
 * then "report it and keep going" is only half implemented.
 */

import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

import { MARKER_COLOR, createErrorMarker, isErrorMarker, resolveMarker } from '../../src/renderer/viewport/markers.js';
import { readVec3, setVec3 } from '../../src/renderer/viewport/vec3.js';

describe('createErrorMarker', () => {
  it('is flagged as an error and as a placeholder', () => {
    const marker = createErrorMarker('prefab threw');
    expect(isErrorMarker(marker)).toBe(true);
    expect(marker.userData['cfPlaceholder']).toBe(true);
  });

  it('carries the reason in both the name and userData', () => {
    const marker = createErrorMarker('model "hero.glb" 404');
    expect(marker.name).toContain('hero.glb');
    expect(marker.userData['message']).toBe('model "hero.glb" 404');
  });

  it('is visually distinct from real geometry', () => {
    const marker = createErrorMarker('broken');
    const material = marker.material as THREE.MeshBasicMaterial;
    expect(material.color.getHex()).toBe(MARKER_COLOR);
    // Wireframe, so it stays distinguishable even in a scene full of red.
    expect(material.wireframe).toBe(true);
  });

  it('has a non-degenerate size', () => {
    const geometry = createErrorMarker('broken').geometry as THREE.BoxGeometry;
    expect(geometry.parameters.width).toBeGreaterThan(0);
  });
});

describe('resolveMarker', () => {
  it('replaces the marker with the loaded model, keeping the parent', () => {
    const parent = new THREE.Group();
    const marker = createErrorMarker('failed');
    parent.add(marker);

    const loaded = new THREE.Group();
    const result = resolveMarker(marker, loaded);

    expect(result).toBe(loaded);
    expect(parent.children).toEqual([loaded]);
    expect(parent.children).not.toContain(marker);
  });

  it('carries the instance id across, so the model is still pickable', () => {
    const marker = createErrorMarker('failed');
    marker.userData['cfInstanceId'] = 'hero';

    const loaded = resolveMarker(marker, new THREE.Group()) as THREE.Object3D;
    expect(loaded.userData['cfInstanceId']).toBe('hero');
    expect(loaded.userData['cfPlaceholder']).toBe(false);
  });

  it('disposes the marker geometry rather than leaking it on every retry', () => {
    const marker = createErrorMarker('failed');
    const dispose = vi.spyOn(marker.geometry, 'dispose');
    const materialDispose = vi.spyOn((marker.material as THREE.Material), 'dispose');

    resolveMarker(marker, new THREE.Group());

    expect(dispose).toHaveBeenCalled();
    expect(materialDispose).toHaveBeenCalled();
  });

  it('refuses to resolve an object that is not a marker', () => {
    const real = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    expect(resolveMarker(real, new THREE.Group())).toBeNull();
    expect(real.parent).toBeNull();
  });

  it('works on a marker with no parent', () => {
    expect(resolveMarker(createErrorMarker('orphan'), new THREE.Group())).not.toBeNull();
  });
});

describe('readVec3 / setVec3', () => {
  it('reads a well-formed vector', () => {
    expect(readVec3([1, 2, 3], 'camera.position')).toEqual([1, 2, 3]);
  });

  it('writes into a Three vector-like target', () => {
    const position = new THREE.Vector3(9, 9, 9);
    setVec3(position, [1, 2, 3], 'camera.position');
    expect(position.toArray()).toEqual([1, 2, 3]);
  });

  it('refuses a two-component vector, naming the field', () => {
    // SPEC §4.2: a 2-component position is an error, never silently padded.
    // A scene that got here bypassed validation, and the message has to say
    // which field and why rather than producing a NaN position.
    expect(() => readVec3([1, 2], 'instances.crate.transform.position')).toThrow(
      /instances\.crate\.transform\.position must have exactly 3 components/,
    );
  });

  it('refuses a four-component vector too', () => {
    expect(() => readVec3([1, 2, 3, 4], 'x')).toThrow(/exactly 3 components/);
  });
});