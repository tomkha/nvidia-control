const { execFileSync } = require('child_process');

const nvidiaSMI = 'nvidia-smi.exe'; // full path to nvidia-smi
const nvidiaInspector = 'nvidiainspector.exe'; // full path to NvidiaInspector

const updateInterval = 1000; // update every second
const voltageStep = 6250; // voltage changes applied in steps

// the following values are set per GPU
const minVoltage = [700000]; // minimum voltage
const maxVoltage = [925000]; // maximum voltage
const startVoltage = [850000]; // set this voltage on startup
const targetTemperature = [60]; // keep this temperature

const Kp = 0.1; // proportional coefficient (0.1 step / 1 degree)

function roundToStep(uV) {
    return voltageStep * Math.round(uV / voltageStep);
}

function getTemperatures() {
    const result = [];
    const output = execFileSync(nvidiaSMI, ['--query-gpu=index,temperature.gpu', '--format=csv,noheader']);
    output.toString('ascii')
        .split(/\r?\n/)
        .filter(line => line.length > 0)
        .forEach(line => {
            const [index, temperature] = line.split(/,\s+/).map(v => parseInt(v));
            result[index] = temperature;
        });
    return result;
}

function setVoltage(microVolts) {
    const args = microVolts.reduce((a, v, i) => {
        return a.concat(`-lockVoltagePoint:${i},${v.toFixed(0)}`);
    }, []);
    console.log('nvidiaInspector', args.join(' '));
    execFileSync(nvidiaInspector, args);
}

let currentVoltage = [];

function updateVoltage() {

    const temperatures = getTemperatures();

    if (temperatures.length === 0) {
        return; // GPU not found
    }

    if (currentVoltage.length === 0) {
        // First time
        currentVoltage = temperatures.map((_, gpuIndex) => roundToStep(startVoltage[gpuIndex] || startVoltage[0]));
        setVoltage(currentVoltage);
    } else {
        const newVoltage = temperatures.map((currentTemperature, gpuIndex) => {
            const dT = (targetTemperature[gpuIndex] || targetTemperature[0]) - currentTemperature;
            const dV = Math.round(dT * Kp * voltageStep);
            const newV = Math.min(Math.max(currentVoltage[gpuIndex] + dV, minVoltage[gpuIndex] || minVoltage[0]), maxVoltage[gpuIndex] || maxVoltage[0]);
            console.log(`#${gpuIndex}: T = ${currentTemperature}, Vcurr = ${currentVoltage[gpuIndex]} uV, dT = ${dT}, dV = ${dV}, Vnew = ${newV} uV`);
            return newV;
        });
        const changed = (newVoltage.findIndex((newV, gpuIndex) => roundToStep(newV) !== roundToStep(currentVoltage[gpuIndex])) >= 0);
        if (changed) {
            setVoltage(newVoltage.map(newV => roundToStep(newV)));
        }

        currentVoltage = newVoltage;
    }

    setTimeout(updateVoltage, updateInterval);
}

updateVoltage();
