const { execFileSync } = require('child_process');

const nvidiaSMI = 'nvidia-smi'; // full path to nvidia-smi
const nvidiaInspector = 'nvidiainspector'; // full path to NvidiaInspector

const devices = []; // list of GPU indexes to control, 0-based, empty = all

const voltageUpdateInterval = 5 * 1000; // update every 5 seconds
const voltageStep = 6250; // voltage changes applied in steps

// the following values are set per GPU
const minVoltage = [700000]; // minimum voltage
const maxVoltage = [925000]; // maximum voltage
const startVoltage = [850000]; // set this voltage on startup
const targetTemperature = [60]; // keep this temperature

const baseClockOffset = [160]; // base clock offset
const memoryClockOffset = [200]; // memory clock offset
const clockOffsetTimeout = 10 * 60 * 1000; // apply base/memory clock offset after 10 minutes

const Kp = 0.1; // proportional coefficient for voltage control (0.1 step / 1 degree)


function query(field, transform) {
    const result = [];
    const output = execFileSync(nvidiaSMI, [`--query-gpu=index,${field}`, '--format=csv,noheader']);
    output.toString('ascii')
        .split(/\r?\n/)
        .filter(line => line.length > 0)
        .forEach(line => {
            const [index, value] = line.split(/,\s+/);
            result[parseInt(index)] = transform ? transform(value) : value;
        });
    return result;
}

function apply(args) {
    if (args.length === 0) {
        return;
    }
    console.log('nvidiaInspector', args.join(' '));
    execFileSync(nvidiaInspector, args);
}

function listGPU() {
    return query('index', index => parseInt(index));
}

function getTemperatures() {
    return query('temperature.gpu', temperature => parseInt(temperature));
}

function setVoltage(gpus, microVolts) {
    const args = [];
    gpus.forEach((gpuIndex, i) => {
        const uV = microVolts[i] || microVolts[0];
        if (uV) {
            args.push(`-lockVoltagePoint:${gpuIndex},${uV.toFixed(0)}`);
        }
    });
    apply(args);
}

function setClockOffset(gpus, baseClockOffset, memoryClockOffset) {
    const args = [];
    gpus.forEach((gpuIndex, i) => {
        const baseOffset = baseClockOffset[i] || baseClockOffset[0];
        if (baseOffset) {
            args.push(`-setBaseClockOffset:${gpuIndex},0,${baseOffset}`); // pstateld=0
        }
        const memOffset = memoryClockOffset[i] || memoryClockOffset[0];
        if (memOffset) {
            args.push(`-setMemoryClockOffset:${gpuIndex},0,${memOffset}`);
        }
    });
    apply(args);
}


const gpus = listGPU()
    .filter((_, i) => (devices.length === 0) || devices.includes(i));

if (gpus.length === 0) {
    console.error('No GPU available');
    process.exit(1);
}

setTimeout(() => {
    setClockOffset(gpus, baseClockOffset, memoryClockOffset);
}, clockOffsetTimeout);


let currentVoltage = [];

function roundVoltageToStep(uV) {
    return voltageStep * Math.round(uV / voltageStep);
}

function updateVoltage() {

    const temperatures = getTemperatures()
        .filter((_, i) => (devices.length === 0) || devices.includes(i));

    if (temperatures.length === 0) {
        return; // no devices, just in case
    }

    if (currentVoltage.length === 0) {
        // First time
        currentVoltage = gpus.map((_, i) => roundVoltageToStep(startVoltage[i] || startVoltage[0]));
        setVoltage(gpus, currentVoltage);
    } else {
        const newVoltage = gpus.map((gpuIndex, i) => {
            const currentTemperature = temperatures[i];
            const dT = (targetTemperature[i] || targetTemperature[0]) - currentTemperature;
            const dV = Math.round(dT * Kp * voltageStep);
            const newV = Math.min(Math.max(currentVoltage[i] + dV, minVoltage[i] || minVoltage[0]), maxVoltage[i] || maxVoltage[0]);
            console.log(`#${gpuIndex}: T = ${currentTemperature}, Vcurr = ${currentVoltage[i]} uV, dT = ${dT.toString().padStart(2)}, dV = ${dV.toString().padStart(5)}, Vnew = ${newV} uV`);
            return newV;
        });
        const changed = (newVoltage.findIndex((newV, i) => roundVoltageToStep(newV) !== roundVoltageToStep(currentVoltage[i])) >= 0);
        if (changed) {
            setVoltage(gpus, newVoltage.map(newV => roundVoltageToStep(newV)));
        }

        currentVoltage = newVoltage;
    }

    setTimeout(updateVoltage, voltageUpdateInterval);
}

updateVoltage();
