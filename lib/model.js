


//contains all current info about running project
exports.Model = function(tmpDir)
{
	var deps = {},
		jsFiles = [],
		scanItemsOnRun = [],
		npmDeps = {},
		parsed = {};
		
	this.VARS = {
		'ROOT_DIR': 1
	};
	
	this.cacheDep = function(original, copied)
	{
		if(copied) deps[original] = copied;
		return deps[original];
	}
	
	//adds an NPM dependency
	this.addNPMDep = function(dep, version)
	{
		// if(npmDeps.indexOf(dep) == -1) npmDeps.push(dep);
		npmDeps[dep] = version;
	}
	
	this.getNPMDeps = function()
	{
		return npmDeps;
	}
	
	this.parsedJSFile = function(file, v)
	{
		if(v) parsed[file] = 1;
		return parsed[file];
	}
	
	//items which need to be scanned on run - parsing content such as config fules
	this.scanFileOnRun = function(item)
	{
		if(scanItemsOnRun.indexOf(item) == -1) scanItemsOnRun.push(item);
	}
	
	this.filesToScan = function()
	{
		return scanItemsOnRun;
	}
	
	//adds a JS file so we know the order which the files are loaded in
	/*this.addJSFile = function(file)
	{
		var absToRel = file.replace(tmpDir + '/', '');
		
		if(jsFiles.indexOf(absToRel) == -1) jsFiles.push(absToRel);
	}
	
	this.parsedJS = function(file, v)
	{
		if(v) parsed[file] = v;
		return parsed[file];
	}
	
	this.getJSFiles = function()
	{
		return jsFiles;
	}*/
}
