const { execFileSync } = require('child_process');

const nvidiaSMI = 'nvidia-smi'; // full path to nvidia-smi
const nvidiaInspector = 'nvidiainspector'; // full path to NvidiaInspector

const devices = []; // list of GPU indexes to control, 0-based, empty = all

const voltageUpdateInterval = 1 * 1000; // update every second
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
    return query('gpu_name');
}

function getTemperatures() {
    return query('temperature.gpu', temperature => parseInt(temperature));
}

function setVoltage(microVolts) {
    const args = microVolts.map((v, i) => {
        const gpuIndex = devices[i] || i;
        return `-lockVoltagePoint:${gpuIndex},${v.toFixed(0)}`;
    });
    apply(args);
}

function setClockOffset(baseClockOffset, memoryClockOffset) {
    const args = baseClockOffset.map((offset, i) => {
        const gpuIndex = devices[i] || i;
        return `-setBaseClockOffset:${gpuIndex},0,${offset}`; // pstateld=0
    }).concat(memoryClockOffset.map((offset, i) => {
        const gpuIndex = devices[i] || i;
        return `-setMemoryClockOffset:${gpuIndex},0,${offset}`;
    }));
    apply(args);
}


const gpus = listGPU()
    .filter((_, i) => (devices.length === 0) || devices.includes(i));

if (gpus.length === 0) {
    console.error('No GPU available');
    process.exit(1);
}

setTimeout(() => {
    setClockOffset(baseClockOffset, memoryClockOffset);
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
        currentVoltage = temperatures.map((_, i) => roundVoltageToStep(startVoltage[i]));
        setVoltage(currentVoltage);
    } else {
        const newVoltage = temperatures.map((currentTemperature, i) => {
            const dT = targetTemperature[i] - currentTemperature;
            const dV = Math.round(dT * Kp * voltageStep);
            const newV = Math.min(Math.max(currentVoltage[i] + dV, minVoltage[i]), maxVoltage[i]);
            console.log(`#${devices[i] || i}: T = ${currentTemperature}, Vcurr = ${currentVoltage[i]} uV, dT = ${dT.toString().padStart(2)}, dV = ${dV.toString().padStart(5)}, Vnew = ${newV} uV`);
            return newV;
        });
        const changed = (newVoltage.findIndex((newV, i) => roundVoltageToStep(newV) !== roundVoltageToStep(currentVoltage[i])) >= 0);
        if (changed) {
            setVoltage(newVoltage.map(newV => roundVoltageToStep(newV)));
        }

        currentVoltage = newVoltage;
    }

    setTimeout(updateVoltage, voltageUpdateInterval);
}

updateVoltage();
