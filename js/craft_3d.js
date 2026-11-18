"use strict";

// The attitude view's model: a simple car built from three.js primitives, so
// there is no model file to load. Ported from gripora-configurator's
// src/js/car_model.js. Y is up and the nose points to -Z (away from the
// camera, so at zero heading the car is seen from behind); about 6 units long
// before the scale set in Craft3D.
const CAR_COLORS = {
  body: 0xff5f1f, // Gripora orange
  chassis: 0x23272f, // Gripora ink, lifted
  glass: 0x1b1e24,
  tyre: 0x141518,
  rim: 0x9aa1ad,
  light: 0xfff4d6,
  tail: 0xd8261c,
};

function carMaterial(color, { roughness = 0.55, metalness = 0.1 } = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

// Extrude a side profile, given as [length, height] points with the front of
// the car at +length, across the car's width. The result is centred on X with
// the front at -Z.
function carSideProfile(points, width, mat) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (const [x, y] of points.slice(1)) {
    shape.lineTo(x, y);
  }
  shape.closePath();

  const bevel = Math.min(0.12, width * 0.05);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: width - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 3,
  });
  geometry.translate(0, 0, -(width - 2 * bevel) / 2);
  // shape X (along the car, front at +X) becomes -Z
  geometry.rotateY(Math.PI / 2);
  return new THREE.Mesh(geometry, mat);
}

function carWheel(x, z, mats) {
  const group = new THREE.Group();

  const tyre = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.55, 32), mats.tyre);
  tyre.rotation.z = Math.PI / 2;
  group.add(tyre);

  const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.57, 6), mats.rim);
  rim.rotation.z = Math.PI / 2;
  group.add(rim);

  group.position.set(x, -0.32, z);
  return group;
}

function createCarModel() {
  const mats = {
    body: carMaterial(CAR_COLORS.body, { roughness: 0.4, metalness: 0.2 }),
    chassis: carMaterial(CAR_COLORS.chassis),
    glass: carMaterial(CAR_COLORS.glass, { roughness: 0.2, metalness: 0.4 }),
    tyre: carMaterial(CAR_COLORS.tyre, { roughness: 0.9, metalness: 0 }),
    rim: carMaterial(CAR_COLORS.rim, { roughness: 0.35, metalness: 0.6 }),
    light: carMaterial(CAR_COLORS.light, { roughness: 0.3 }),
    tail: carMaterial(CAR_COLORS.tail, { roughness: 0.3 }),
  };

  const car = new THREE.Group();
  car.name = "car";

  // Flat chassis plate under everything
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.18, 6.0), mats.chassis);
  chassis.position.set(0, -0.42, 0);
  car.add(chassis);

  // Body up to the waistline: low nose, fuller rear
  car.add(
    carSideProfile(
      [
        [3.05, -0.33],
        [3.05, 0.0],
        [2.2, 0.28],
        [-2.4, 0.38],
        [-3.0, 0.32],
        [-3.0, -0.33],
      ],
      2.75,
      mats.body,
    ),
  );

  // Cabin (windows) on top
  car.add(
    carSideProfile(
      [
        [1.1, 0.3],
        [0.15, 0.92],
        [-1.25, 0.92],
        [-2.05, 0.36],
      ],
      2.15,
      mats.glass,
    ),
  );

  // Wheels: front axle at -Z
  for (const [x, z] of [
    [-1.5, -1.95],
    [1.5, -1.95],
    [-1.5, 2.0],
    [1.5, 2.0],
  ]) {
    car.add(carWheel(x, z, mats));
  }

  // Rear wing on two struts
  const wing = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.07, 0.6), mats.chassis);
  wing.position.set(0, 0.9, 2.75);
  car.add(wing);
  for (const x of [-0.75, 0.75]) {
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.28), mats.chassis);
    strut.position.set(x, 0.62, 2.75);
    car.add(strut);
  }

  // Headlights at the front, tail lights at the back, so heading reads at a glance
  for (const x of [-0.9, 0.9]) {
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.14, 0.08), mats.light);
    head.position.set(x, 0.02, -3.2);
    car.add(head);

    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.12, 0.08), mats.tail);
    tail.position.set(x, 0.2, 3.15);
    car.add(tail);
  }

  return car;
}

class Craft3D {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
    });
    this.renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    // three.js r126 (js/vendor/three.min.js) has no colour management: the hex colours
    // below are rendered as given with the default linear output.
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(
      75,
      canvas.clientWidth / canvas.clientHeight,
      0.1,
      1000,
    );
    // Behind the car and a little above it, so the roof and the far side stay in
    // view; the camera does not move with the attitude.
    this.camera.position.set(0, 70, 190);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(this.camera);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
    this.scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.6);
    directionalLight.position.set(300, 600, 800);
    this.scene.add(directionalLight);

    // modelWrapper adds an extra axis of rotation to avoid gimbal lock with the euler angles:
    // heading turns the wrapper about Y, pitch and roll turn the model inside it (X, then Z).
    this.modelWrapper = new THREE.Object3D();
    this.scene.add(this.modelWrapper);

    this.model = createCarModel();
    this.model.scale.setScalar(24);
    this.modelWrapper.add(this.model);
    this.render();
  }

  // x: pitch (nose up positive), y: heading (nose left positive), z: roll (right side up
  // positive), in radians; the caller converts and negates the log's attitude.
  rotateTo(x, y, z) {
    if (!this.model) return;

    this.model.rotation.x = x;
    this.modelWrapper.rotation.y = y;
    this.model.rotation.z = z;
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  resize(width, height) {
    if (this.canvas.width != width || this.canvas.height != height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.renderer.setSize(width, height);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.render();
    }
  }
}
