const { execFileSync } = require('child_process');

const nvidiaSMI = 'nvidia-smi'; // full path to nvidia-smi
const nvidiaInspector = 'nvidiainspector'; // full path to NvidiaInspector

const voltageUpdateInterval = 1 * 1000; // update every second
const voltageStep = 6250; // voltage changes applied in steps

// the following values are set per GPU
const minVoltage = [700000]; // minimum voltage
const maxVoltage = [925000]; // maximum voltage
const startVoltage = [850000]; // set this voltage on startup
const targetTemperature = [60]; // keep this temperature

const baseClockOffset = [160];
const memoryClockOffset = [200];
const clockOffsetTimeout = 1 * 60 * 1000; // 1 minute

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
    const args = microVolts.map((v, gpuIndex) => {
        return `-lockVoltagePoint:${gpuIndex},${v.toFixed(0)}`;
    });
    apply(args);
}

function setClockOffset(baseClockOffset, memoryClockOffset) {
    const args = baseClockOffset.map((offset, gpuIndex) => {
        return `-setBaseClockOffset:${gpuIndex},0,${offset}`; // pstateld=0
    }).concat(memoryClockOffset.map((offset, gpuIndex) => {
        return `-setMemoryClockOffset:${gpuIndex},0,${offset}`;
    }));
    apply(args);
}


const gpus = listGPU();
if (gpus.length === 0) {
    console.error('No GPU found');
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

    const temperatures = getTemperatures();

    if (currentVoltage.length === 0) {
        // First time
        currentVoltage = temperatures.map((_, gpuIndex) => roundVoltageToStep(startVoltage[gpuIndex]));
        setVoltage(currentVoltage);
    } else {
        const newVoltage = temperatures.map((currentTemperature, gpuIndex) => {
            const dT = targetTemperature[gpuIndex] - currentTemperature;
            const dV = Math.round(dT * Kp * voltageStep);
            const newV = Math.min(Math.max(currentVoltage[gpuIndex] + dV, minVoltage[gpuIndex]), maxVoltage[gpuIndex]);
            console.log(`#${gpuIndex}: T = ${currentTemperature}, Vcurr = ${currentVoltage[gpuIndex]} uV, dT = ${dT}, dV = ${dV}, Vnew = ${newV} uV`);
            return newV;
        });
        const changed = (newVoltage.findIndex((newV, gpuIndex) => roundVoltageToStep(newV) !== roundVoltageToStep(currentVoltage[gpuIndex])) >= 0);
        if (changed) {
            setVoltage(newVoltage.map(newV => roundVoltageToStep(newV)));
        }

        currentVoltage = newVoltage;
    }

    setTimeout(updateVoltage, voltageUpdateInterval);
}

updateVoltage();
