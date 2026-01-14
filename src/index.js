import axios from 'axios';

export class EntryBlock {

    constructor({pipelineId, entryBlockId, entryPoint= "", entryAuthCode}) {
        if (!pipelineId || !entryBlockId) {
            throw new Error('pipelineId and entryBlockId are required');
        }

        this.pipelineId = pipelineId;
        this.entryBlockId = entryBlockId;
        this.entryPoint = entryPoint;
        this.entryAuthCode = entryAuthCode;
    }

    runSync(body) {
        let result; 
        let resolved; 
        // run the entry block sync
        const headers = {
            'Content-Type': 'application/json',
            'X-Entry-Auth-Code': this.entryAuthCode,
        }

        const entryPoint = this.entryPoint ? this.entryPoint + "." : "";

        // check if body is not string, then we stringify it
        const stringifiedBody = typeof body === 'string' ? body : JSON.stringify(body);

        axios.post(`https://${entryPoint}entry.on.kitchen/${this.pipelineId}/${this.entryBlockId}/sync`, stringifiedBody, {
            headers: headers
        }).then((response) => {
            resolved = true;
            result = response.data;
        }).catch((error) => {
            resolved = true;
            result = error.response.data;
        });

        while (!resolved) {
            require('deasync').sleep(100); // Sleep for a short time to avoid busy-waiting
        }

        return result;
    }

    pollStatus(runId) {
        let status;
        let resolved = false;
        const headers = {
            'Content-Type': 'application/json',
            'X-Entry-Auth-Code': this.entryAuthCode,
        };
        const entryPoint = this.entryPoint ? this.entryPoint + "." : "";
        console.log("Polling", `https://${entryPoint}entry.on.kitchen/${this.pipelineId}/pollstatus/${runId}`);
        axios.get(`https://${entryPoint}entry.on.kitchen/${this.pipelineId}/pollstatus/${runId}`, {
            headers: headers
        }).then((response) => {
            console.log("pollStatus response:", response.data);
            resolved = true;
            status = response.data;
        }).catch((error) => {
            resolved = true;
            status = error.response.data;
            console.error('Unable to pollStatus:', error);
        })
        while (!resolved) {
            require('deasync').sleep(100); // Sleep for a short time to avoid busy-waiting
        }
        return status;
    }

    pollStatusAsync(runId) {
        const headers = {
            'Content-Type': 'application/json',
            'X-Entry-Auth-Code': this.entryAuthCode,
        };
        const entryPoint = this.entryPoint ? this.entryPoint + "." : "";
        return axios.get(`https://${entryPoint}entry.on.kitchen/${this.pipelineId}/pollstatus/${runId}`, {
            headers: headers
        }).then((response) => {
            return response.data;
        }).catch((error) => {
            return error.response.data;
        });
    }

    runAsync(body) {
        // run the entry block async
        const headers = {
            'Content-Type': 'application/json',
            'X-Entry-Auth-Code': this.entryAuthCode,
        };
        const entryPoint = this.entryPoint ? this.entryPoint + "." : "";
        // check if body is not string, then we stringify it
        const stringifiedBody = typeof body === 'string' ? body : JSON.stringify(body);

        // return a promise that continually runs pollStatus until the status is finished
        return new Promise((resolve, reject) => {
            axios.post(`https://${entryPoint}entry.on.kitchen/${this.pipelineId}/${this.entryBlockId}/async`, stringifiedBody, {
                headers: headers
            }).then(async (response) => {
                let runId = response.data.runId;
                let status = await this.pollStatusAsync(runId);
                while (status.status === "running") {
                    status = await this.pollStatusAsync(runId);
                }
                if (status.status === "finished") {
                    resolve(status);
                }
                else {
                    reject(status);
                }
            }).catch((error) => {
                console.error('Unable to runAsync:', error);
            });
        });
    }
    
}
