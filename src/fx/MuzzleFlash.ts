import * as THREE from 'three';

export class MuzzleFlash {
  private light: THREE.PointLight;
  private timeRemaining = 0;

  constructor(private scene: THREE.Scene) {
    this.light = new THREE.PointLight(0xffddaa, 0, 10);
    this.light.visible = false;
    this.scene.add(this.light);
  }

  emit(origin: THREE.Vector3, direction: THREE.Vector3) {
    // Offset slightly forward
    this.light.position.copy(origin).addScaledVector(direction, 0.5);
    this.light.intensity = 5;
    this.light.visible = true;
    this.timeRemaining = 0.05; // 50ms flash
  }

  update(dt: number) {
    if (this.timeRemaining > 0) {
      this.timeRemaining -= dt;
      if (this.timeRemaining <= 0) {
        this.light.visible = false;
        this.light.intensity = 0;
      }
    }
  }

  dispose() {
    this.scene.remove(this.light);
    this.light.dispose();
  }
}
