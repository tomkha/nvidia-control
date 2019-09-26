const { execFileSync, execSync, spawn } = require('child_process');
const readline = require('readline');

const nvidiaSMI = {
  path: 'nvidia-smi', // full path to nvidia-smi
  updateInterval: 1000,
  maxValues: 10
};
const nvidiaInspector = './nvidiainspector'; // full path to NvidiaInspector

const devices = []; // list of GPU indexes to control, 0-based, empty = all

const voltageUpdateInterval = 1 * 1000; // update every 5 seconds
const voltageStep = 6250; // voltage changes applied in steps

// the following values are set per GPU
const minVoltage = [700000]; // minimum voltage
const maxVoltage = [925000]; // maximum voltage
const startVoltage = [850000]; // set this voltage on startup
const targetTemperature = [60]; // keep this temperature
const maxTemperature = [90];

const baseClockOffset = [160]; // base clock offset
const memoryClockOffset = [200]; // memory clock offset
const clockOffsetTimeout = 10 * 60 * 1000; // apply base/memory clock offset after 10 minutes

const Kp = 0.1; // proportional coefficient for voltage control (0.1 step / 1 degree)

// fields = array of fields to query
// interval = update interval in milliseconds
// max = maximum measurements to store
function runNvidiaSMI(fields, transform, interval, max) {
  if (fields[0] !== 'index') {
    fields.unshift('index');
  }

  let exited = false;
  const values = [];

  const proc = spawn(nvidiaSMI.path, [`--loop-ms=${interval}`, `--query-gpu=${fields.join(',')}`, '--format=csv,noheader']);

  const rl = readline.createInterface({ input: proc.stdout });
  rl.on('line', line => {
    if (line.length > 0) {
      const arr = line.split(/,\s+/);
      if (arr.length !== fields.length) {
        console.error(`Parse error: ${line}`);
      } else {
        const gpuIndex = parseInt(arr[0]);
        if (!values[gpuIndex]) {
          values[gpuIndex] = []; // first update, init with empty value
        }
        values[gpuIndex].push(transform(arr.slice(1))); // all except 0 (index)
        if (values[gpuIndex].length > max) {
          values[gpuIndex].shift(); // remove old values
        }
      }
    }
  });

  proc.stderr.on('data', data => {
    console.error(`Error: ${data}`);
  });
  proc.on('close', code => {
    console.log(`Nvidia-SMI exited with code ${code}`);
    exited = true;
    rl.close();
  });

  const getValues = (gpuIndex, field, limit) => {
    if (exited) {
      return undefined; // no longer actual
    }
    const fieldIndex = fields.indexOf(field);
    if (fieldIndex === -1) {
      return undefined; // unknown field
    }
    if (!values[gpuIndex]) {
      return undefined; // wrong GPU
    }
    const result = values[gpuIndex].map(v => v[fieldIndex - 1]); // -1 because we don't store GPU index
    if (limit && result.length > limit) {
      return result.slice(result.length - limit); // last 'limit' values
    }
    return result;
  };

  return {
    forEach: (gpus, callback) => {
      Object.keys(values)
        .map(gpuIndex => parseInt(gpuIndex))
        .filter(gpuIndex => !Array.isArray(gpus) || gpus.length === 0 || gpus.includes(gpuIndex))
        .forEach((gpuIndex, index) => {
          callback({
            getIndex: () => gpuIndex,
            getValues: (field, limit) => getValues(gpuIndex, field, limit),
            getValue: (field) => getValues(gpuIndex, field, 1)[0],
            getAverage: (field, limit) => {
              const arr = getValues(gpuIndex, field, limit);
              return (arr.length > 0) ? arr.reduce((a, b) => a + b, 0) / arr.length : undefined;
            }
          }, index);
        });
    }
  };
}

function apply(args) {
  if (args.length === 0) {
    return;
  }
  console.log('nvidiaInspector', args.join(' '));
  execFileSync(nvidiaInspector, args);
}

function reboot() {
  // Windows only
  execSync('shutdown /r');
}

// Run nvidia-smi in the background
const monitor = runNvidiaSMI(['temperature.gpu', 'power.draw'],
  values => [parseInt(values[0]), parseInt(values[1])], // convert to numbers
  nvidiaSMI.updateInterval, nvidiaSMI.maxValues);

// Set clock offset (once)
setTimeout(() => {

  const args = [];
  monitor.forEach(devices, (gpu, i) => {
    const baseOffset = baseClockOffset[i] || baseClockOffset[0];
    if (baseOffset) {
      args.push(`-setBaseClockOffset:${gpu.getIndex()},0,${baseOffset}`); // pstateld=0
    }
    const memOffset = memoryClockOffset[i] || memoryClockOffset[0];
    if (memOffset) {
      args.push(`-setMemoryClockOffset:${gpu.getIndex()},0,${memOffset}`);
    }
  });
  apply(args);

}, clockOffsetTimeout);


// Voltage/temperature control
let currentVoltage = [];

setInterval(() => {

  // Check max temperature
  let maxTemperatureReached = false;
  monitor.forEach(devices, (gpu, i) => {
    const currentTemperature = gpu.getValue('temperature.gpu');
    const maxTemp = (maxTemperature[i] || maxTemperature[0]);
    if (currentTemperature >= maxTemp) {
      maxTemperatureReached = true;
      console.log(`GPU #${gpu.getIndex()} reached max temperature (${currentTemperature} >= ${maxTemp})`);
    }
  });
  if (maxTemperatureReached) {
    console.log('Maximum temperature reached, rebooting');
    reboot();
    return;
  }

  // Voltage control
  const roundVoltageToStep = (uV) => voltageStep * Math.round(uV / voltageStep);
  const args = [];
  monitor.forEach(devices, (gpu, i) => {
    // First time
    if (!currentVoltage[i]) {
      const uV = roundVoltageToStep(startVoltage[i] || startVoltage[0]);
      currentVoltage[i] = uV;
      args.push(`-lockVoltagePoint:${gpu.getIndex()},${uV.toFixed(0)}`);
      return;
    }
    // Next time
    const currentTemperature = gpu.getValue('temperature.gpu');
    const dT = (targetTemperature[i] || targetTemperature[0]) - currentTemperature;
    const dV = Math.round(dT * Kp * voltageStep);
    const newVoltage = Math.min(Math.max(currentVoltage[i] + dV, minVoltage[i] || minVoltage[0]), maxVoltage[i] || maxVoltage[0]);
    console.log(`#${gpu.getIndex()}: T = ${currentTemperature}, Vcurr = ${currentVoltage[i]} uV, dT = ${dT.toString().padStart(2)}, dV = ${dV.toString().padStart(5)}, Vnew = ${newVoltage} uV`);

    // Add arg for this GPU only if necessary
    const changed = roundVoltageToStep(newVoltage) !== roundVoltageToStep(currentVoltage[i]); // at different step
    if (changed) {
      const uV = roundVoltageToStep(newVoltage);
      args.push(`-lockVoltagePoint:${gpu.getIndex()},${uV.toFixed(0)}`);
    }

    currentVoltage[i] = newVoltage;
  });
  apply(args);


}, voltageUpdateInterval);