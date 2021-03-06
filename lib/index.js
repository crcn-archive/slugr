require('./logger');

var fs = require('fs'),
exec = require('child_process').exec,
path = require('path'),
dirname = path.dirname,
util = require('util'),
Queue = require('./queue').Queue,
Model = require('./model').Model,
utils = require('./utils');


var _scanFiles = function(dir, callback)
{
	fs.readdirSync(dir).forEach(function(file)
	{
		if(file.substr(0,1) == '.') return;

		var fullPath = dir + '/' + file,
		stat = fs.lstatSync(fullPath);
		
		if(stat.isDirectory())
		{
			_scanFiles(fullPath, callback);
		}
		else
		{
			callback(fullPath);
				
		}
	});
}

//replaces __dirname with the absolute path 
var _replacePathWithDir = function(str, dir)
{
	return str.replace('__dirname', '\'' + dir + '\'').replace(/[\'\"](\.\.?\/)/, '\'' + dir + '$1');
}

var _scanJSFile = function(ops, next)
{
	var model = ops.model,
		input = ops.input;
	
	if(model.parsedJSFile(input)) return next();
	model.parsedJSFile(input,true);
	
	var q = new Queue(),
	inputDir = dirname(input) + '/',
	output = ops.output,
	outputDir =dirname(output) + '/',
	tmpDir = ops.tmpDir,
	content = fs.readFileSync(input,'utf8');
	
	
	
	//include the paths so we can call require.resolve for any dependency
	var _includePaths = function(next)
	{
		var paths = content.match(/require.paths.\w+\(.*?\)/g) || [];		
			
		paths.forEach(function(path)
		{
			var p = _replacePathWithDir(path, inputDir).match(/\((.*?)\)/)[1];
			
			try
			{
				p = fs.realpathSync(eval(p));
				require.paths.unshift(p)
			}
			catch(e)
			{
			}
		});
		
		next();
	}
	
	//fixes the javascript content so any references to javascript files
	//are pointing to the js files within the slug
	var _fixDependencies = function(next)
	{
		
		//parse any require(...)
		var deps = content.match(/[\s]?require\(.*?\)/g) || [],
			q = new Queue();			
		
		
		//then loop through them
		deps.forEach(function(required)
		{
			//need to queue each dependency because it might need to be parsed which is async
			q.add(function(nx)
			{
				var pkg, toLoad, fullPath;
				
				try
				{
					toLoad = _replacePathWithDir(required, inputDir);
					
					//strip require(), and evaluate the string content
					pkg = eval(toLoad.match(/require\((.*?)\)/)[1]);
						
					fullPath = require.resolve(pkg);
						
					
					var org = model.cacheDep(fullPath);	
					
					//not part of the app? it's a library located elsewhere on the system
					if(!org)
					{
						var rpaths = require.paths;
						for(var i = rpaths.length; i--;)
						{
							if(fullPath.indexOf(rpaths[i]) > -1)
							{
								var cpath = rpaths[i];
								break;
							}
						}
						
						
						if(cpath && cpath.indexOf('/usr/local/lib/node') == -1)
						{
							var dir = tmpDir + '/node_modules/' + dirname(fullPath).replace(cpath,'');
							
							exec('mkdir -p '+dir, function()
							{
								dir = fs.realpathSync(dir);
								_scanJSFile({ input: fullPath, output: dir + '/' + fullPath.split('/').pop(), tmpDir: tmpDir, model: model }, nx);								
							});
							return;
						}
						else
						if(cpath && fullPath.indexOf('@') > -1) //check for NPM package ~ [PACKAGE]@[VERSION]
						{
							var packageInfo = fullPath.match(/([^\/]+)@([^\/]+)/),
								name = packageInfo[1],
								version = packageInfo[2];
								
							model.addNPMDep(name, version);
						}
					}
					
					//tell the model to scan the current JS file
					else
					{
						_scanJSFile({ input: fullPath, output: org, tmpDir: tmpDir, model: model }, nx);
					}
					
					
					nx();
				}

				//error either because:
				//1. the item needs to be loaded in via npm
				//2. the path has some vars in it which cannot be evaluated
				catch(e)
				{
					console.error('unable to process %s', (fullPath || pkg || toLoad || '').toString().replace(/^\s+/g,''))
					nx();
				}
			})
			
		});
		
		
		q.start(next);
	}
	
	var _writeJS = function(next)
	{
		model.cacheDep(input, output);
		
		var q = new Queue();
		
		if(!model.cacheDep(inputDir))
		{
			model.cacheDep(inputDir, outputDir);
			
			_scanFiles(inputDir, function(file)
			{
				if(file.split('.').pop() == 'js') return;
				
				q.add(function(next)
				{
					exec('cp '+file+' '+file.replace(inputDir, outputDir), next);
				});
				
			})
		}
		 
		
		// model.addJSFile(output);
		// model.parsedJS(output, true)
		
		fs.writeFileSync(output, content);
		
		q.start(next);
	}
	
	
	q.add(_includePaths);
	q.add(_fixDependencies);
	q.add(_writeJS);
	q.start(next);
}

var _copyDependencies = function(ops, next)
{
	var q = new Queue(),
		input = ops.input,
		output = ops.output,
		tmpDir = ops.tmpDir,
		model = ops.model;
		
	
	var _copyFiles = function(next)
	{
		var q = new Queue(),
			jsToParse = [];
		
		_scanFiles(input, function(file)
		{
			var outputPath = file.replace(input, output),
				fileType = file.split('.').pop();
				model.cacheDep(file, outputPath);
				
			q.add(function(nx)
			{
				exec('mkdir -p ' + dirname(outputPath), function()
				{
					try
					{
						if(fileType == 'js')
						{
							jsToParse.push({ input: file, output: outputPath, tmpDir: tmpDir, model: model });
						}
						else
						{
							fs.writeFileSync(outputPath, fs.readFileSync(file, 'utf8'));
						}
						
						nx();
						
					}catch(e)
					{
						console.log(e.stack)
					}
				});
			});
		});
		
		q.start(function(nx)
		{
			jsToParse.forEach(function(cfg)
			{
				q.add(function(nx)
				{
					_scanJSFile(cfg, nx);
				});
			});

			q.add(next);

			nx();
		});
	}
	
	
	q.add(_copyFiles);
	q.start(next);
}



var _writeSlugFromOps = function(ops, callback)
{
	if(!ops.slug) ops.slug = {};
	
	var q = new Queue(),
	cwd = process.cwd(),

	//the temporary directory where the slug lives
	tmpDir   = '/tmp/slugr-build';

	//contains all global data for given project
	model = new Model(tmpDir),

	//the output directory to write the *.slug to
	output   = ops.output || ops.slug.output,

	//the input project that will be bundled into the slug
	input    = ops.main,
	
	//the root app directory
	inputDir = dirname(input),

	//the name of the slug e.g: myApp.slug
	name     = ops.name || 'slugr',

	//the argv to pass to the slug on startup
	args     = ops.args || ops.slug.args || [],

	//TRUE the npm dependencies are compiled with the slug
	bundle   = ops.bundle || ops.slug.bundle;
	

	if(!input) return console.error('input missing');



	//makes a temporary directory where the build process happens
	var _makeTempDirectory = function(next)
	{
		console.ok('Making temporary build directory');

		exec('rm -rf ' + tmpDir, function()
		{
			exec('mkdir -p ' + tmpDir, next);
		});
	}


	//copies the target files to the 
	var _copyTarget = function(next)
	{
		console.ok('Copying target source files');

		_copyDependencies({ input: dirname(input), tmpDir: tmpDir, output: tmpDir + '/app', model: model }, next);
	}


	//scans the arguments of for anything which can be parsed into the slug. 
	//Mainly files
	var _scanArguments = function(next)
	{
		console.ok('Scanning args for parsable content');

		var q = new Queue(),

		//the directory for content passed from argv. Motivation = some of my apps
		//use a configuration file, and I want them to live within the slug so I'm not worried
		//about file references that don't exist.
		argvd = tmpDir + '/argv';

		args.forEach(function(arg, index)
		{
			//files will have /, so check 
			if(arg.indexOf('/') > -1)
			{
				try
				{
					var argStat = fs.lstatSync(arg);

					//TODO: copy the contents of the directory.
					if(!argStat.isDirectory())
					{
						q.add(function(nx)
						{
							var newArg = arg.replace(dirname(arg), argvd);
							
							//need to replace the tmp directory with ./ so we can use relative path vs absolute.
							//$SLUG_ROOT gets changed back into ABS on init
							args[index] = newArg.replace(tmpDir,'./');
							
							exec('mkdir -p '+argvd, function()
							{
								//json file? = config most likely
								if(arg.indexOf('.json') > -1)
								{
									var content = fs.readFileSync(arg,'utf8');
									1
									if(content.indexOf(inputDir) > -1)
									{
										//replace the abs path with the root dir var 
										content = content.replace(new RegExp(inputDir,'g'), '${ROOT_DIR}');
									}
									
									
									model.scanFileOnRun(newArg.replace(tmpDir,'.'));
									
									fs.writeFileSync(newArg, content);
									nx();
								}
								else
								{
									//copy the files now
									exec('cp '+arg+' '+newArg, nx);
								}
							});
							
						})
					}
				}

				//not *really* a file? ignore it.
				catch(e)
				{

				}
			}
		});

		q.start(next);
	}

	//writes the bootstrap code which gets called each time the slug is loaded up.
	var _writeBootstrap = function(next)
	{
		console.ok('Writing slug bootstrap');
		
		var target = './app/' + input.split('/').pop();
		//include the target file specified in -i
		var slug = 'require("'+target+'"); ';
		
		//write the index so we can call the slug from the target directory
		fs.writeFileSync(tmpDir + '/index.js', slug);

		//ops = NPM package
		var pk = utils.copy(ops);
		
		//replace package main with rel path
		pk.main = target;
		
		//set the dependencies so we can npm link against the slug
		pk.dependencies = model.getNPMDeps();
		
		//add the slug args so the app knows how to handle the package on load
		pk.slug = { bundle: bundle, args: args, scanFiles: model.filesToScan() };
		
		fs.writeFileSync(tmpDir + '/package.json', JSON.stringify(pk));


		next();
	}

	var _bundleApp = function(next)
	{
		//if bundle=true, then bundle all NPM packages into the .slug file. This can make the slug file
		//REALLY big depending on the packages ~ 25MB
		if(bundle)
		{
			console.ok('Writing npm bundle...');


			exec('cd ' + tmpDir + '; npm bundle; ', function()
			{
				console.ok('Done writing bundle');
				next();
			});
		}
		else
		{
			console.success('Skipping npm bundle');
			next();
		}
	}

	//bundles up the app into a .slug file
	var _compileSlug = function(next)
	{
		console.ok('Compiling slug');

		exec('cd ' + tmpDir + '; tar -pczf ' + output + '/' + name + '.slug ./*; rm -rf ' + tmpDir, function(err)
		{
			console.success('Done writing  %s/%s.slug', output, name);
			next();
		})
	}


	q.add(_makeTempDirectory);
	q.add(_copyTarget);
	q.add(_scanArguments);
	q.add(_writeBootstrap);
	q.add(_bundleApp);
	q.add(_compileSlug);
	q.start(callback);
}

var _writeSlugFromConfigFile = function(src, callback)
{
	_writeSlugFromOps(JSON.parse(fs.readFileSync(src, 'utf8')));
}

var _writeSlug = function(ops, callback)
{
	if(typeof ops == 'string')
	{
		_writeSlugFromConfigFile(ops, callback);
	}
	else
	{
		_writeSlugFromOps(ops, callback);
	}
}

function _runTargetProject(inputFile, callback)
{
	var tmp = '/tmp/slugr-run-' + process.pid,
		q = new Queue();
	
	console.success('Reading slug');
	
	//dump the slug into a temporary directory
	exec('mkdir -p '+ tmp+'; cd '+tmp+'; tar -xf '+ inputFile, function(err)
	{
		//load up the configuration for the slug file
		var config = JSON.parse(fs.readFileSync(tmp + '/package.json','utf8')),
			scanFiles = config.slug.scanFiles || [],
			args = config.slug.args,
			appDir = tmp + '/app',
			model = new Model();
		
		//check the arguments for anything that needs to be replaced on the fly
		for(var i = args.length; i--;)
		{
			if(args[i].indexOf('./') == 0)
			{
				args[i] = args[i].replace('./', tmp)
			}
		}
		
		//retain the first two args, but remove the next, and add the default args
		process.argv = process.argv.splice(0,2).concat(args);
		
		
		
		if(!config.slug.bundle)
		{
			q.add(function(next)
			{
				console.success('Installing slug');
				exec('cd '+tmp+'; npm link;', next);
			})
		}
		
		scanFiles.forEach(function(file)
		{
			file = file.replace('./', tmp + '/');
			
			var content = fs.readFileSync(file,'utf8');
			
			for(var arg in model.VARS)
			{
				var a = '${'+arg+'}';
				
				if(content.indexOf(a) > -1)
				{
					content = content.replace(new RegExp(a.replace(/(\W)/g,'\\$1'),'g'), appDir);
				}

				fs.writeFileSync(file, content);
			}
		});
		
		q.start(function()
		{
			console.success('Running slug');
			//include the slug file
			require(tmp);
		})
		
		
		
		if(callback) callback();
	});
}

exports.write = _writeSlug;
exports.run   = _runTargetProject;