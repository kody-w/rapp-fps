import * as THREE from 'three';

export class MuzzleFlash {
  public light: THREE.PointLight;
  private timeRemaining = 0;
  private framesPresented = 0;

  constructor(private scene: THREE.Scene) {
    this.light = new THREE.PointLight(0xffddaa, 0, 10);
    this.light.visible = true;
    this.scene.add(this.light);
  }

  emit(origin: THREE.Vector3, direction: THREE.Vector3) {
    this.light.position.copy(origin).addScaledVector(direction, 0.5);
    this.light.intensity = 5;
    this.timeRemaining = 0.05;
    this.framesPresented = 0;
  }

  update(dt: number) {
    if (this.light.intensity > 0) {
      this.framesPresented++;
      this.timeRemaining -= dt;
      if (this.timeRemaining <= 0 && this.framesPresented > 1) {
        this.light.intensity = 0;
      }
    }
  }

  reset() {
    this.light.intensity = 0;
    this.timeRemaining = 0;
    this.framesPresented = 0;
  }

  dispose() {
    this.scene.remove(this.light);
    this.light.dispose();
  }
}
