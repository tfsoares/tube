export namespace proxy {
	
	export class CaptureEntry {
	    id: string;
	    timestamp: number;
	    method: string;
	    path: string;
	    host: string;
	    requestHeaders: Record<string, string>;
	    requestBody: string;
	    statusCode: number;
	    responseHeaders: Record<string, string>;
	    responseBody: string;
	    duration: number;
	
	    static createFrom(source: any = {}) {
	        return new CaptureEntry(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.timestamp = source["timestamp"];
	        this.method = source["method"];
	        this.path = source["path"];
	        this.host = source["host"];
	        this.requestHeaders = source["requestHeaders"];
	        this.requestBody = source["requestBody"];
	        this.statusCode = source["statusCode"];
	        this.responseHeaders = source["responseHeaders"];
	        this.responseBody = source["responseBody"];
	        this.duration = source["duration"];
	    }
	}
	export class TunnelStatus {
	    ngrok: boolean;
	    tailscale: boolean;
	    funnel: boolean;
	    urls: Record<string, string>;
	
	    static createFrom(source: any = {}) {
	        return new TunnelStatus(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.ngrok = source["ngrok"];
	        this.tailscale = source["tailscale"];
	        this.funnel = source["funnel"];
	        this.urls = source["urls"];
	    }
	}

}

